// ESLint 配置。
//
// 目标是抓 bug，不是统一代码风格。
// 这个项目里的很多写法是刻意的、并且有注释解释过原因：
//   `x == null` 一次判 null 和 undefined、`catch {}` 明确表示"失败也无所谓"、
//   `while (true)` 配显式上限的避让循环。
// 把风格规则打开只会产生几百条噪音，然后大家学会忽略 lint 输出——
// 那比没有 lint 更糟。所以这里只留"几乎不可能是故意写的"那一类规则。
//
// 三种运行环境必须分开配，混在一起 no-undef 就废了：
//   主进程 / 测试 / 脚本 —— Node CommonJS，有 require、__dirname、process
//   渲染进程 —— 浏览器，没有 require（contextIsolation: true），依赖靠 <script> 全局
//   双用模块（i18n / frontmatter）—— 两边都要跑，所以两套 global 都给

const globals = require('globals');

// 渲染进程里由 <script> 提前声明、renderer.js 直接裸名取用的全局。
// 这些不在任何 import 里，no-undef 认不出来，必须显式列。
//
// 只列真正裸用的两个。vendor 那三个库（marked / DOMPurify / diff_match_patch）
// 不能列在这里：renderer.js 是先 `const marked = window.marked.marked` 取到本地
// 再用的，把同名全局也声明上去，那三行 const 就成了重复声明（no-redeclare 报错）。
// 它们走 window.X，由 globals.browser 的 window 覆盖，不需要单独声明。
const rendererGlobals = {
  // src/i18n.js 与 src/frontmatter.js 在全局声明的常量
  I18N: 'readonly',
  FRONTMATTER: 'readonly'
};

// 只保留能指向真实缺陷的规则。每条都注明了它在这个项目里能抓到什么。
const correctnessRules = {
  // 拼错的变量名、忘了声明的变量。渲染进程里最值钱的一条：
  // 打错一个函数名不会有任何提示，点到那个按钮才炸。
  'no-undef': 'error',
  // 改名之后没删干净的旧变量、少传的参数。args: 'after-used' 才不会
  // 把 (e, rel) 里没用到的 e 判成问题——IPC 处理器普遍是这个形状。
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    caughtErrors: 'none',
    varsIgnorePattern: '^_'
  }],
  // 同名声明两次。i18n.js 的注释里就记着一次真实事故：renderer.js 里重复
  // 声明 I18N 会抛 already been declared，导致整个 renderer.js 一行都不执行。
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',        // i18n 表有 500 行，同 key 写两遍靠肉眼看不出来
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',      // 提前 return 之后还写了代码
  'no-fallthrough': 'error',
  'no-cond-assign': 'error',      // if (x = 1) 这种把 == 写成 = 的
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-finally': 'error',   // finally 里 return 会吞掉异常
  'no-unsafe-optional-chaining': 'error',
  'no-sparse-arrays': 'error',
  'no-prototype-builtins': 'error',
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-constant-binary-expression': 'error',
  'no-useless-backreference': 'error',
  'no-invalid-regexp': 'error',
  'no-control-regex': 'off',      // 路径安全检查里刻意匹配 \0
  'no-misleading-character-class': 'error',
  'no-obj-calls': 'error',
  'no-import-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-const-assign': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-setter-return': 'error',
  'no-this-before-super': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',        // typeof x === 'strng' 这种拼错

  // `catch {}` 在这个项目里到处都是且是刻意的（stat 失败就当文件不存在），
  // 所以只禁真正空的 if/for 块。
  'no-empty': ['error', { allowEmptyCatch: true }],

  // eval 系列在 Electron 里是实打实的安全问题：正文全部来自用户导入的 .md，
  // 一次 eval 就能把 XSS 升级成任意代码执行。
  // 测试里有三处刻意的 eval / new Function（从 renderer.js 原文截取被测函数，
  // 不抄副本——抄副本的测试会在源码改动后继续测那份旧副本），
  // 它们各自带 eslint-disable-next-line 注明。开这几条规则的意义就在于：
  // 除了那三处显式豁免，任何新增的 eval 都会被拦下来。
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',

  // 下面这些故意关掉，都是这个代码库里有意为之的写法：
  'no-constant-condition': ['error', { checkLoops: false }], // while(true) + 显式上限
  'require-atomic-updates': 'off',  // 按 key 串行的写队列本来就是读改写，误报率高
  'no-console': 'off',              // 自检和诊断全靠 console
  eqeqeq: 'off'                     // `== null` 一次判两种空值，是约定
};

module.exports = [
  {
    // vendor 是第三方库的原样副本，由 npm run sync-vendor 生成，
    // 改它没有意义（下次同步就被覆盖）。dist 是构建产物。
    ignores: ['src/vendor/**', 'dist/**', 'node_modules/**']
  },
  {
    // 主进程、测试、构建脚本：Node CommonJS
    files: ['electron-main.js', 'preload.js', 'lib/**/*.js', 'tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: correctnessRules
  },
  {
    // 渲染进程：浏览器环境，没有 require。
    // sourceType 必须是 script 而不是 module —— 这几个文件是靠 <script> 标签
    // 加载的，顶层的 const 就是全局声明，不是模块作用域。
    files: ['src/renderer.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...rendererGlobals }
    },
    rules: correctnessRules
  },
  {
    // 双用模块：浏览器里当 <script>，主进程里被 require。
    // 两套 global 都要给，否则结尾那句 typeof module !== 'undefined' 会报 no-undef。
    files: ['src/i18n.js', 'src/frontmatter.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: correctnessRules
  }
];
