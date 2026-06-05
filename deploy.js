const { NodeSSH } = require('node-ssh');
const ssh = new NodeSSH();
const path = require('path');

async function deploy() {
  try {
    await ssh.connect({
      host: '100.115.71.58',
      username: 'yeci',
      password: 'shawnyin226'
    });
    console.log('Connected to server');
    
    let projectDir = '/Users/yeci/Desktop/linovelib-reader';
    console.log(`Deploying to ${projectDir}...`);
    
    const localDirs = ['app', 'components', 'lib'];
    for (const dir of localDirs) {
      console.log(`Uploading ${dir}...`);
      await ssh.putDirectory(path.join(__dirname, dir), `${projectDir}/${dir}`, {
        recursive: true,
        concurrency: 10
      });
    }

    console.log('Uploading package.json...');
    await ssh.putFile(path.join(__dirname, 'package.json'), `${projectDir}/package.json`);

    console.log('Running npm install and restarting...');
    const cmds = [
      `export PATH=$PATH:/usr/local/bin:~/.nvm/versions/node/v20.9.0/bin:~/.npm-global/bin:/opt/homebrew/bin`,
      `cd ${projectDir}`,
      `npm install`,
      `npm run build`,
      `pm2 restart linovelib-server || pm2 start npm --name "linovelib-server" -- run start`
    ];
    
    const res = await ssh.execCommand(cmds.join(' && '));
    console.log('STDOUT:', res.stdout);
    console.log('STDERR:', res.stderr);
    
    ssh.dispose();
  } catch (err) {
    console.error('Error during deployment:', err);
    ssh.dispose();
  }
}

deploy();
