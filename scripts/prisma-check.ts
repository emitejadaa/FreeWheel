import { spawnSync } from 'node:child_process';

function main() {
  run('npx', ['prisma', 'validate']);
  run('npx', ['prisma', 'generate']);

  const schemaChanged = spawnSync('git', ['diff', '--quiet', '--', 'prisma/schema.prisma'], {
    stdio: 'ignore',
    shell: true,
  }).status !== 0;

  if (schemaChanged) {
    console.log('');
    console.log('prisma/schema.prisma has uncommitted changes.');
    console.log('Review migration impact before running npx prisma migrate dev.');
    console.log('Do not run db push or destructive migrations against production without explicit confirmation.');
  }
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
