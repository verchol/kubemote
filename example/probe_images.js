const
    _ = require('lodash'),
    fs = require('fs'),
    KubemoteWrapper = require('../src/kubemoteWrapper'),
    Kubemote = require('../src/kubemote')
    kefir = require('kefir'),
    uuid = require('uuid'),
    util = require('util'),
    yaml = require('js-yaml')
    path = require('path');

  let jobTemplate = yaml.safeLoad(fs.readFileSync(path.resolve(__dirname, './templates/jobs.yaml'), "utf-8"));
  let allImages = true;


module.exports.listImages= ({remote=new Kubemote({host:"127.0.0.1", port:8001, protocol:"http"}), imageId="all_images",
 byName=false, imageName, waitPeriod=10000})=>{

  probeStream = kefir
        .fromPromise(remote.getNodes())
        .map((podList)=> _(podList["items"]).map('metadata.name').uniq().value())
        .flatMap((nodeNameList)=> {
            return kefir.combine(
                nodeNameList.map((nodeName)=> {
                    let jobName = _(uuid.v4()).split('-').first();
                    _.set(jobTemplate, "metadata.name", jobName);
                    _.set(jobTemplate, "metadata.labels.job-name", jobName);
                    _.set(jobTemplate, "spec.template.metadata.labels.job-name", jobName);
                    _.set(jobTemplate, "spec.template.spec.nodeName", nodeName);
                    _.set(jobTemplate, "spec.template.spec.containers[0].args[1]", "docker inspect $(docker images -aq --no-trunc)");


                    return kefir
                        .concat([
                            kefir.fromPromise(remote.createJob(jobTemplate)).ignoreValues(),
                            kefir.fromPromise(remote.watchJob({ jobName })).flatMap((stopWatch)=>{
                                let stream = kefir
                                    .stream(emitter=>{
                                      letId = waitPeriod;
                                       remote.on('watch',(jobResult)=>{
                                         emitter.emit(jobResult);
                                         //emitter.end();
                                       });
                                      let timeoutId;
                                      let retry = (waitPeriod)=>{
                                        if (!waitPeriod)
                                        return clearTimeout(timeoutId);
                                        waitPeriod= -1000;
                                        timeoutId = setTimeout(retry, 1000);
                                      }
                                      setTimeout(retry, 1000);

                                    })

                                    .filter(_.matches({ object: { kind: "Job", metadata: { name: jobName }} }))
                                    .filter((watchNotification)=> _.get(watchNotification, 'object.status.completionTime'))
                                    .take(1)
                                    .flatMap((watchNotification)=> _.get(watchNotification, 'object.status.succeeded') ?
                                        kefir.fromPromise(remote.getPods({ "job-name": jobName })).map(_.partial(_.get, _, 'items.0.metadata.name')) :
                                        kefir.constantError('Failed to complete task'))
                                    .flatMap((podName)=> kefir.fromPromise(remote.getPodLogs({ podName })))
                                    .map(_.flow((image)=>{
                                      return image;
                                    },JSON.parse, (images)=> images.map((image)=> _.assign(image, { _source: nodeName }))));

                                stream.onEnd(stopWatch);
                                return stream;
                            })//.takeUntilBy(kefir.later(waitPeriod, 1))
                            ,kefir.later().flatMap(()=> kefir.fromPromise(remote.deleteJob({ jobName })))   .ignoreValues()
                        ])
                })
            )
        })
        .map(
            (images)=> _(images)
                .chain()
                .flatten()
                .uniqBy('Id')
                //.groupBy('Id')
                //.mapValues((images)=> _(images).chain().head().assign({ _source: _(images).groupBy('_source').keys().value() }).value()) //_(images).take(1).map((image)=> _.assign(image, { _source: _.map(image, '_source') })).first()
                .toArray()
                .value()
        );
//TODO : put flags , all
//
//probeStream.onValue((images)=> console.log(["The following images are available throughout Kubernetes:", ...images.map(({ Id, Config})=> ` ${Id}- ${util.format(Config.Labels)}`)].join('\n')));
images = probeStream.flatten().map(({Id, RepoTags, Config}, filter)=>{
  return {Id,
      RepoTags,
      Labels: Config.Labels}
});
 //.filter(({Id})=> allImages ||  Id == imageId ).log('');
/*imageWithLabels = probeStream.flatten().map(imageInfo.Labels)
 .filter(({Id})=> allImages ||  Id == imageId )
 .filter(({Id , Labels})=>!_.isEmpty(Labels)).log('withLabels');
 */
 probeStream.onError(console.warn);

return images;
}
