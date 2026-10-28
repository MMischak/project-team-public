import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPublicationFile } from '../scripts/check-publication.mjs';

test('publication guard rejects private paths, credentials, personal metadata and active images while allowing synthetic fixtures', () => {
  const check = (path, text = '') => checkPublicationFile(path, Buffer.from(text));
  assert.ok(check('native-home/session.json').includes('private-or-generated-path'));
  assert.ok(check('docs/source/notes.md').includes('private-or-generated-path'));
  assert.ok(check('example.md', ['/Users','private-person','Documents'].join('/')).includes('absolute-user-home'));
  assert.ok(check('example.md', ['person','private-mail.test'].join('@')).includes('non-example-email'));
  assert.ok(check('example.md', ['ghp', 'A'.repeat(36)].join('_')).includes('credential-pattern'));
  assert.ok(check('image.svg', '<svg><script>example</script></svg>').includes('active-or-external-image-content'));
  assert.deepEqual(check('tests/example.test.ts', 'test@example.invalid git@github.com:owner/repo.git'), []);
  assert.deepEqual(check('docs/guide.md', 'Use your configured local state directory.'), []);
});
