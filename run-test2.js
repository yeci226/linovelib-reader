const { NodeSSH } = require('node-ssh');
const ssh = new NodeSSH();
ssh.connect({host:'100.115.71.58', username:'yeci', password:'shawnyin226'}).then(async () => {
  const res = await ssh.execCommand('export PATH=$PATH:/usr/local/bin:~/.nvm/versions/node/v20.9.0/bin:~/.npm-global/bin:/opt/homebrew/bin && cd /Users/yeci/Desktop/linovelib-reader && node -e "const db = require(\'better-sqlite3\')(\'data/reader.db\'); console.log(db.prepare(\'SELECT count(*) FROM DiscoverCache\').get());"');
  console.log('STDOUT:', res.stdout);
  console.log('STDERR:', res.stderr);
  ssh.dispose();
});
