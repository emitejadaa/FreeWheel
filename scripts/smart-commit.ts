import { spawnSync } from 'node:child_process';

const commitIndex = process.argv.indexOf('--commit');
const requestedMessage = commitIndex >= 0 ? process.argv.slice(commitIndex + 1).join(' ').trim() : '';

function main() {
  const status = output('git', ['status', '--short']);

  if (!status.trim()) {
    console.log('No changes to commit.');
    return;
  }

  const sensitiveFiles = status
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter((file) => file !== '.env.example')
    .filter((file) => /^\.env($|\.|\\|\/)/.test(file) || /secret|credential|token/i.test(file));

  if (sensitiveFiles.length > 0) {
    console.error('Refusing to continue because potentially sensitive files are changed:');
    for (const file of sensitiveFiles) {
      console.error(`- ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Changed files:');
  console.log(status);

  const diffStat = output('git', ['diff', '--stat']);
  if (diffStat.trim()) {
    console.log('');
    console.log('Diff stat:');
    console.log(diffStat);
  }

  console.log('');
  console.log('Suggested Conventional Commit scopes: docs(agents), test(api), chore(render), chore(env), chore(prisma).');

  if (!requestedMessage) {
    console.log('');
    console.log('No commit was created. To commit after reviewing checks, run:');
    console.log('git add <related-files>');
    console.log('npm run commit:smart -- --commit "docs(agents): add project agent workflow"');
    return;
  }

  if (!/^(feat|fix|test|docs|chore|refactor|ci|build)(\([a-z0-9-]+\))?: .+/.test(requestedMessage)) {
    console.error('Commit message must follow Conventional Commits, for example: docs(agents): update workflow');
    process.exitCode = 1;
    return;
  }

  run('npm', ['run', 'build']);
  run('npm', ['test', '--', '--runInBand']);

  const stagedCheck = spawnSync('git', ['diff', '--cached', '--quiet'], {
    stdio: 'ignore',
    shell: true,
  });

  if (stagedCheck.status === 0) {
    console.error('No staged changes found. Stage the related files explicitly before committing.');
    process.exitCode = 1;
    return;
  }

  run('git', ['commit', '-m', requestedMessage]);
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  }

  return result.stdout;
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
