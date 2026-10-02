// tests/composer-meta.test.js
const COMPOSER_META = require('../src/composer-meta');

let failures = 0;
const ok = (cond, msg, extra) => {
  if (cond) console.log('[test:composer-meta] PASS ' + msg);
  else { failures++; console.error('[test:composer-meta] FAIL ' + msg + (extra ? ' -> ' + extra : '')); }
};
const stack = (name) => 'prompts/snippets/stacks/' + name + '.md';
const meta = (stacks) => COMPOSER_META.infer({ stacks });

ok(meta([stack('frontend-react')]).projectType === '前端项目', 'React 识别为前端项目');
ok(meta([stack('backend-fastapi')]).projectType === '后端项目', 'FastAPI 识别为后端项目');
ok(meta([stack('client-electron')]).projectType === '桌面应用', 'Electron 识别为桌面应用');
ok(meta([stack('frontend-react'), stack('backend-fastapi')]).projectType === '全栈项目', '前后端组合识别为全栈项目');
ok(meta([]).projectType === '其他', '未选技术栈时使用其他');
const tags = meta([stack('backend-fastapi')]).tags;
ok(tags.includes('FastAPI') && tags.includes('后端') && !tags.includes('React'), '标签跟随所选技术栈', JSON.stringify(tags));

if (failures) process.exit(1);
console.log('[test:composer-meta] 通过');
