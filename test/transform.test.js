const assert = require('assert');
const { transformSource, findSourceRootPath, parsePackage } = require('../out/transform');

const base = {
  oldName: 'FooService',
  newName: 'BarService',
  oldPkg: 'com.foo.aaa001',
  newPkg: 'com.foo.aaa002',
  siblingClasses: ['FooService', 'Helper', 'Unused', 'Other'],
  targetClasses: [],
  eol: '\n',
};

// 1. package change + rename + import of same-package class
{
  const src = [
    'package com.foo.aaa001;',
    '',
    'import java.util.List;',
    '',
    '/** FooService helper. Unused is only mentioned here. */',
    'public class FooService {',
    '    private static final Logger log = LoggerFactory.getLogger(FooService.class);',
    '    public FooService() {}',
    '    private Helper helper;',
    '    String s = "Other";',
    '}',
    '',
  ].join('\n');
  const r = transformSource(src, base);
  assert(r.text.includes('package com.foo.aaa002;'));
  assert(!r.text.includes('aaa001;') || r.text.includes('import com.foo.aaa001.Helper;'));
  assert(r.text.includes('public class BarService {'));
  assert(r.text.includes('getLogger(BarService.class)'));
  assert(r.text.includes('public BarService() {}'));
  assert(r.text.includes('/** BarService helper.'));
  assert.deepStrictEqual(r.addedImports, ['Helper']); // Unused (comment) and Other (string) are not imported
  assert(r.text.includes('import java.util.List;\nimport com.foo.aaa001.Helper;'));
  assert.strictEqual(r.renamed, 4);
}

// 2. no existing imports -> inserted after the package line
{
  const src = 'package com.foo.aaa001;\n\npublic class FooService {\n    Helper h;\n}\n';
  const r = transformSource(src, base);
  assert(r.text.startsWith('package com.foo.aaa002;\n\nimport com.foo.aaa001.Helper;\n'));
}

// 3. CRLF is preserved
{
  const src = 'package com.foo.aaa001;\r\n\r\nimport java.util.List;\r\n\r\npublic class FooService {\r\n    Helper h;\r\n}\r\n';
  const r = transformSource(src, { ...base, eol: '\r\n' });
  assert(!/(?<!\r)\n/.test(r.text), 'bare LF introduced');
  assert(r.text.includes('import com.foo.aaa001.Helper;'));
}

// 4. same package, only renaming -> no imports, no package change
{
  const src = 'package com.foo.aaa001;\n\npublic class FooService {\n    Helper h;\n}\n';
  const r = transformSource(src, { ...base, newPkg: 'com.foo.aaa001' });
  assert.deepStrictEqual(r.addedImports, []);
  assert(r.text.includes('package com.foo.aaa001;'));
  assert(r.text.includes('class BarService'));
}

// 5. same simple name already in the target package -> skipped, not imported
{
  const src = 'package com.foo.aaa001;\n\npublic class FooService {\n    Helper h;\n}\n';
  const r = transformSource(src, { ...base, targetClasses: ['Helper'] });
  assert.deepStrictEqual(r.addedImports, []);
  assert.deepStrictEqual(r.skippedImports, ['Helper']);
}

// 6. already imported / wildcard-imported classes are left alone
{
  const src = 'package com.foo.aaa001;\n\nimport com.foo.aaa001.Helper;\n\npublic class FooService {\n    Helper h;\n}\n';
  const r = transformSource(src, base);
  assert.deepStrictEqual(r.addedImports, []);
  const src2 = 'package com.foo.aaa001;\n\nimport com.foo.aaa001.*;\n\npublic class FooService {\n    Helper h;\n}\n';
  assert.deepStrictEqual(transformSource(src2, base).addedImports, []);
}

// 7. member access like x.Helper is not a type reference
{
  const src = 'package com.foo.aaa001;\n\npublic class FooService {\n    Object o = cfg.Helper;\n}\n';
  assert.deepStrictEqual(transformSource(src, base).addedImports, []);
}

// 8. helpers
assert.strictEqual(parsePackage('// c\npackage a.b.c;\nclass X {}'), 'a.b.c');
assert.strictEqual(findSourceRootPath('/p/src/main/java/com/foo/aaa001', 'com.foo.aaa001'), '/p/src/main/java');
assert.strictEqual(findSourceRootPath('/p/src/other', 'com.foo'), undefined);
assert.strictEqual(findSourceRootPath('/p/src', ''), '/p/src');

console.log('all transform tests passed');
