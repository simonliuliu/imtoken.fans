// The SDK may retain request timers after a failed offline experiment. This
// supervisor only terminates its own worker, and never treats that as success.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultWorker=fileURLToPath(new URL('./walletconnect-universal-offline.mjs',import.meta.url));
const worker=process.env.IMTOKEN_WALLET_QA_WORKER_PATH||defaultWorker;
if(!path.isAbsolute(worker)) throw new Error('QA worker path must be absolute');
const child=spawn(process.execPath,[worker],{
  env:{...process.env,IMTOKEN_WALLET_OFFLINE_WORKER:'1'},
  stdio:['ignore','pipe','pipe'],
});
let passedReports=0;
let failedReports=0;
let invalidReports=0;
let lastReportStatus;
let stopReason;
let failureTimer;
let forceTimer;
let overallTimer;
function stopWorker(reason) {
  if(stopReason||child.exitCode!==null||child.signalCode!==null) return;
  stopReason=reason;
  child.kill('SIGTERM');
  forceTimer=setTimeout(()=>{
    if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL');
  },2000);
  forceTimer.unref();
}
function scheduleFailureStop(reason) {
  if(failureTimer) return;
  failureTimer=setTimeout(()=>stopWorker(reason),3000);
  failureTimer.unref();
}
function forward(stream,target) {
  let pending='';
  stream.on('data',chunk=>{
    const data=chunk.toString();
    target.write(data);
    pending+=data;
    let index;
    while((index=pending.indexOf('\n'))!==-1) {
      const line=pending.slice(0,index);pending=pending.slice(index+1);
      try {
        const report=JSON.parse(line);
        if(report.status==='passed') { passedReports++;lastReportStatus='passed'; }
        if(report.status==='failed') {
          failedReports++;lastReportStatus='failed';
          scheduleFailureStop('failure cleanup timeout');
        }
        if(Object.prototype.hasOwnProperty.call(report,'status')&&report.status!=='passed'&&report.status!=='failed') {
          invalidReports++;lastReportStatus='invalid';
          scheduleFailureStop('invalid result cleanup timeout');
        }
      } catch {}
    }
    if(pending.length>65536) pending=pending.slice(-65536);
  });
}
forward(child.stdout,process.stdout);
forward(child.stderr,process.stderr);
overallTimer=setTimeout(()=>stopWorker('overall timeout'),45000);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>stopWorker('interrupted'));
child.on('error',error=>{
  clearTimeout(overallTimer);
  process.stderr.write(JSON.stringify({status:'failed',phase:'supervisor startup',errorName:error.name})+'\n');
  process.exitCode=1;
});
child.on('close',(code,signal)=>{
  clearTimeout(overallTimer);clearTimeout(failureTimer);clearTimeout(forceTimer);
  if(stopReason) process.stderr.write(JSON.stringify({status:'failed',phase:'supervisor',reason:stopReason,signal})+'\n');
  const passed=passedReports===1&&failedReports===0&&invalidReports===0&&lastReportStatus==='passed'&&!stopReason&&code===0;
  if(!passed&&!stopReason&&!failedReports) process.stderr.write(JSON.stringify({status:'failed',phase:'supervisor',reason:'invalid worker result',code,signal})+'\n');
  process.exitCode=passed?0:1;
});
