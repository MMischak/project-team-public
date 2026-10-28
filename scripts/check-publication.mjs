import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkPublicationFile(path, data) {
  const issues = [];
  if (/(?:^|\/)(?:node_modules|dist|native-home|\.runtime|\.codex|\.agents|\.aws|\.ssh|\.test-artifacts)(?:\/|$)/.test(path) || /(?:^|\/)(?:auth\.json|credentials(?:\.json)?|\.env(?:\..*)?|\.gitleaksignore|\.gitleaks\.toml)$/.test(path) && !path.endsWith('.env.example') || /\.(?:sqlite\w*(?:-wal|-shm)?|db(?:-wal|-shm)?|jsonl|log|pem|key|p12|pfx)$/.test(path) || /^docs\/(?:source|session-notes|implementation\/qa)\//.test(path)) issues.push('private-or-generated-path');
  if (path.endsWith('.png')) {
    if (!data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return [...issues, 'invalid-png'];
    let offset = 8;
    while (offset + 12 <= data.length) { const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8); if (['tEXt','zTXt','iTXt','eXIf','caBX'].includes(type)) issues.push('image-metadata'); offset += length + 12; }
    return issues;
  }
  const text = data.toString('utf8');
  if (/(?:\/Users\/|\/home\/)[a-zA-Z0-9_.-]+(?:\/|\b)/.test(text) || /[A-Z]:\\Users\\[^\\\s]+/i.test(text)) issues.push('absolute-user-home');
  if (/https?:\/\/(?:app\.)?notion\.(?:com|so)\//i.test(text)) issues.push('private-source-reference');
  if (/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push('credential-pattern');
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) ?? [];
  if (emails.some(email => email !== 'git@github.com' && !/@(?:[^@]+\.)?invalid$/i.test(email) && !/@example\.(?:com|org|net)$/i.test(email))) issues.push('non-example-email');
  if (path.endsWith('.svg') && /<script\b|<metadata\b|<foreignObject\b|(?:href|src)=["']https?:/i.test(text)) issues.push('active-or-external-image-content');
  return [...new Set(issues)];
}

export function checkTrackedPublication(root) {
  if (realpathSync(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()) !== realpathSync(root)) throw new Error('Run from the standalone publication repository.');
  const entries = execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean), findings = [];
  for (const entry of entries) {
    const [metadata, path] = entry.split('\t');
    if (!metadata.startsWith('100644 ') && !metadata.startsWith('100755 ') || lstatSync(join(root, path)).isSymbolicLink()) { findings.push({ path, rules: ['link-or-submodule'] }); continue; }
    const rules = checkPublicationFile(path, readFileSync(join(root, path))); if (rules.length) findings.push({ path, rules });
  }
  return { checkedFiles: entries.length, findings, passed: findings.length === 0 };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = checkTrackedPublication(fileURLToPath(new URL('..', import.meta.url)));
  console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
}
