describe('spinner', ()=>{
  it.skip('spinner',(done)=>{
    var Spinner = require('cli-spinner').Spinner;
    let spinner = new Spinner('processing.. %s');
    spinner.setSpinnerString('|/-\\');
    spinner.start();
    setTimeout(()=>{
      spinner.stop();
    }, 2000)
  })
  let timer =   (spinner)=>{
    console.log('new timer')
    spinner.start();
    setTimeout(()=>{
      spinner.stop();
      timer(spinner);
    }, 2000)
  }
  it('spinner1',(done)=>{
    var Spinner = require('cli-spinner').Spinner;
    let spinner = new Spinner('processing.. %s');
     spinner.setSpinnerString(18);
     timer(spinner);
  })
})
