#!/usr/bin/env node
const
    _ = require('lodash'),
    util = require('util'),
    yargs = require('yargs'),
    kefir = require('kefir'),
    Table = require('cli-table'),
    Spinner = require('cli-spinner').Spinner,
    Kubemote = require('../src/kubemote');

    let spinner;
    const createSpinner = (progressMsg="processing..")=>{
      (spinner) ? spinner.stop() : spinner;
      spinner = new Spinner(`${progressMsg} %s`);
      spinner.setSpinnerString(18);
      return spinner;
    };


let client,cmdLineArgs;





cmdLineArgs = yargs
    .version(false)
    .usage("$0 --columns [[column identifiers]] --context [context] --deploy [deployment] --namespace [namespace] --format [json|table] --host [host] --port [port] --protocol [http|https]")
    .group(["deployment", "namespace"], 'Query Options:')
    .option('deployment', {
        type: "string",
        description: "Show one specific deployment name",
        alias: "deploy"
    })
    .option('jobWaitPeriod', {
        default : 20000,
        type: "number",
        description: "Show how long to wait in milliseconds",
        alias: "jobwait"
    })
    .option('namespace', {
        type: "string",
        description: "Query within a namespace",
        default:  "default",
        alias: "ns"
    })
    .group(["columns", "format"], 'Report Composition:')
    .option('colSize',
    //  alias: "col",
    { type: "array",
      description: "define columns size",
      coerce: (args)=>{
        let colSize = {}
        let options = _(args).map((arg)=>{
          let opts = arg.split(/[,=]/)
          _.assign(colSize, _.set({}, opts[0], ~~opts[1]));
        }).value();
        return colSize;
      }
    })

    .option('col', {

        type: "array",
        default:  {default:  {"name": 10,
          "desired" : 5,
          "current" : 5,
          "images" : 40,
          "pods" : 10,
          "selectors":10}
        },
        description: "Columns to include in the report",
        demandOption: "Please provide a list of required columns",
        coerce: (args)=>{

          const choices =
          {"name": 20,
          "desired" : 5,
          "current" : 5,
          "available" : 5,
          "age" : 10,
          "images" : 40,
          "pods" : 10,
          "selectors":10};

           if (_.get(args[0], "default"))
              return    args[0].default;


          if (!args)
          return choices;
          const colWidth  = [];
          _.fill(colWidth, choices.length, 10 )
;
          let shownCols = {};
          _.remove(args, (m)=>{
                return m.match(/^[,=?]$/g);
          });
          let options = _(args).map((arg)=>{
            let opts = arg.split(/[,=]/)
            _.set(shownCols, opts[0], !!(~~opts[1])? ~~opts[1] : 10 , 10);
            return arg;
          }).value();

          return shownCols;
        }
    })
    .option('format', {
        description: "Report type",
        choices: ["table", "json"],
        default: "table",
        type: "array",
        coerce: _.last
    })
    .group(["port", "host", "protocol", "context"], 'Connection:')
    .option('port', {
        type: "number",
        desc: "The port number to use when connecting",
        implies: ["host", "protocol"]
    })
    .option('proxy', {
      description : "use kubectl proxy to connect",
      //implies: ["host", "port", "protocol"],
    }).coerce('proxy', (argv)=>{

      opts = _.split(argv ,/[:,/]/g);
      let proxyOpts = {}
      _.set(proxyOpts , "protocol", "http")
      _.set(proxyOpts , "host", opts[0])
      _.set(proxyOpts , "port", opts[1])

      return proxyOpts;
    })
    .option('host', {
        type: "string",
        desc: "The host name to use when connecting",
        implies: ["port", "protocol"]
    })
    .option('protocol', {
        type: "string",
        desc: "The protocol to use for connection",
        choices: ["http", "https"],
        implies: ["host", "port"]
    })
    .option('context', {
        type: "string",
        description: "Use a specific configuration context",
        alias: "ctx"
    })
    .argv;

if (cmdLineArgs.proxy){
  cmdLineArgs.host = cmdLineArgs.proxy.host;
  cmdLineArgs.port = ~~(cmdLineArgs.proxy.port);
  cmdLineArgs.protocol = cmdLineArgs.proxy.protocol;
}


let col = _(cmdLineArgs).get('col');

_(col).forEach((v, k)=>{
  if (_.hasIn(cmdLineArgs.colSize, k))
  _.set(cmdLineArgs.col, k ,_.get(cmdLineArgs.colSize , k))
})



const generateDeploymentsReport = function({
    context,
    namespace = "default",
    deployment = "",
    extended = false,
    host,
    port,
    protocol
}){


    try {
        client = new Kubemote(_.defaults({ host, port, protocol }, Kubemote.CONFIGURATION_FILE({ namespace, context })));
        client.setMaxListeners(1000);
    } catch(error){
        return Promise.reject(error);
    }
    createSpinner('collecting data from K8s cluster...').start();
    let getDeployStream =  kefir
        .fromPromise(client.getDeployments())
        .flatMap((res)=> {
            return kefir.combine(
                (res["kind"] === "Deployment" ? [res] : res["items"])
                    .filter((deployment && _.matchesProperty('metadata.name', deployment)) || _.constant(true))
                    .map((deploymentDoc)=> {
                        return kefir.combine([
                            kefir.constant({deploy: deploymentDoc}),
                            extended ?
                                kefir
                                    .fromPromise(client.getPods(_.get(deploymentDoc, 'spec.selector.matchLabels')))
                                    .map(({ items: podDocs }) => {

                                        return {
                                            podNames: _.chain(podDocs).map('metadata.name').value(),
                                            containers: _.chain(podDocs).map((v, k)=>{
                                             let containers = _.get(v, 'status.containerStatuses', []);
                                             if (!containers[0])
                                                console.log('containers is not running ' + util.format(v));
                                              return _.get(v, 'status.containerStatuses', []);
                                            }).flatten().value()
                                        }
                                    }) :
                                kefir.constant({})
                        ], _.merge)
                    })
            );
        })
        .map((report)=>{

            return report.map((item)=> {
                let [name, replicas, updatedReplicas, unavailableReplicas, creationTimestamp, containers, podNames, labels] = _.zipWith(_.at(item, [
                    "deploy.metadata.name",
                    "deploy.status.replicas",
                    "deploy.status.updatedReplicas",
                    "deploy.status.unavailableReplicas",
                    "deploy.metadata.creationTimestamp",
                    "containers",
                    "podNames",
                    "deploy.metadata.labels"
                ]), [
                    _.identity,
                    _.toInteger,
                    _.toInteger,
                    _.toInteger,
                    Date.parse,
                    _.identity,
                    _.identity,
                    _.identity,
                ], (v, f) => f(v));

                return Object.assign({
                    name,
                    desired: replicas,
                    current: updatedReplicas,
                    available: replicas - unavailableReplicas,
                    age: Date.now() - creationTimestamp,
                    selectors: labels
                }, extended && {
                    images: containers,
                    pods: podNames
                });
            })
        })
        .mapErrors((e) => _.identity(e))
        .takeErrors(1);

      getDeployStream.onEnd(_.noop);


        return getDeployStream.toPromise();
};
const listImages = require('./probe_images').listImages;
const reportFormatters = {
    "json": (columns, rawReport)=>
    util.inspect(rawReport.map((row)=> _.pick(row, _.keys(columns))), { depth: 10 }),
    "table": (function(){
        const timeSpanFormatter = (function(){
                const
                    MIL_IN_SEC = 1000,
                    MIL_IN_MIN = 60 * MIL_IN_SEC,
                    MIL_IN_HOUR = 60 * MIL_IN_MIN,
                    MIL_IN_DAY = 24 * MIL_IN_HOUR,
                    factors = [MIL_IN_DAY, MIL_IN_HOUR, MIL_IN_MIN, MIL_IN_SEC],
                    captions = ["s", "m", "h", "d"];

                return (span)=>
                    _(factors)
                        .map((function(ac){
                            return (factor)=> {
                                let sectionValue = ~~(ac / factor);
                                ac = ac % factor;
                                return sectionValue;
                            }
                        })(span))
                        .dropWhile(_.negate(Boolean))
                        .reverse()
                        .map((v, index)=> [_.padStart(v, 2, '0'), captions[index]].join(''))
                        .reverse()
                        .join(':');
            })();

        const columnsFormats = {
            "name": { caption: "Name" },
            "desired": { caption: "Desired" },
            "current": { caption: "Current" },
            "available":  { caption: "Available" },
            "age": { caption: "Age", formatter: timeSpanFormatter },
            "images": { caption: "Images(s)", formatter: (containers, imagesList)=>{
               (!containers) ? containers = [] : containers;
               let all = containers.slice(0,1).map(({image})=>{

               //let truncatedImage = _.truncate(image, { length: 80 });

               let tags =  [_.chain(imagesList).filter((i)=>{
                   //console.log(`${image}-${util.format(i)} , ${i.RepoTags}`);
                   let tags = _.get(i, "RepoTags", []);
                  return _(tags).some((tag)=> tag === image)
            }).map((i)=>i.Labels).head().value()];

            return image + "\nlabels : \n======\n" + _.chain(tags)
            .head()
            .map((v, k)=>{
              return `${k}=${v}`
            }).join('\n')
          })
             return all.join('\n');
        }
      },
            "pods": { caption: "Pod(s)", formatter: (podNames)=> podNames.map((pod)=> _.truncate(pod, { length: 50 })).join('\n') },
            "selectors": { caption: "Selectors", formatter: (labels)=> _.truncate(_.map(labels, (v, k) => `${k}=${v}`).join('\n'), { length: 100 }) }
        };

        return function(columns, rawReport){

            let table = new Table(
              { head: _.map(columns , (width , col)=> {
                  return columnsFormats[col]["caption"]
                })

              , colWidths: _.values(columns)

          });
            rawReport.forEach((row)=> table.push(_.map(columns,
              (width, columnName)=>
              (columnsFormats[columnName].formatter || _.identity)(row[columnName],
                 rawReport.imagesList)))) ;
            return table.toString();
        };
    })()
};
createSpinner('collecting deployments ...').start();
generateDeploymentsReport(
    Object.assign(
        _.pick(cmdLineArgs, ["namespace", "deployment", "context"]),
        { extended: _(cmdLineArgs["col"]).keys().some((selectedColumn)=> ["pods", "images"].includes(selectedColumn))},
        _.at(cmdLineArgs, ["port", "host", "protocol"]).some(Boolean) && _.pick(cmdLineArgs, ["port", "host", "protocol"])
    ))

    .then((report)=>{
      createSpinner('collecting image metadata...').start();
      if (!cmdLineArgs["col"].images) return report;

      return listImages({waitPeriod:cmdLineArgs.jobWaitPeriod}).scan((prev , next)=>{
        prev.push(next);
        return prev;
      }, []).toPromise().then((images)=>{
          report.imagesList = images;
          return report;
      })

    })
    .then((report)=>{
      createSpinner('generatingReport...').start();
      let reportGenerator = _.partial(reportFormatters[cmdLineArgs["format"]],
      cmdLineArgs["col"] || {name:10})
      return reportGenerator(report);
    })
    .then((report)=>{
      (spinner) ? spinner.stop() : spinner;
      console.log(' Report is ready!');
      return report;
    })
    .then(console.log)
    .catch((e)=>{
      console.warn(e);
      (spinner) ? spinner.stop() : spinner;
    });
