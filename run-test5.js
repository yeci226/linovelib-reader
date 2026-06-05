const { NodeSSH } = require('node-ssh');
const ssh = new NodeSSH();
ssh.connect({host:'100.115.71.58', username:'yeci', password:'shawnyin226'}).then(async () => {
  const res = await ssh.execCommand('curl -s "http://localhost:3001/search?q=%e5%82%b2"');
  console.log('STDOUT:', res.stdout);
  console.log('STDERR:', res.stderr);
  ssh.dispose();
});
