// 根据项目装配器选择的技术栈生成可筛选的元数据。浏览器与 Node 测试共用。
const COMPOSER_META = {
  infer(values) {
    const stacks = Array.isArray(values && values.stacks) ? values.stacks : [];
    const has = (name) => stacks.some(s => String(s).endsWith('/' + name + '.md'));
    const front = has('frontend-react');
    const back = has('backend-fastapi');
    const desktop = has('client-electron');
    const tags = ['脚手架', '规约', '初始化'];
    if (front) tags.push('前端', 'React');
    if (back) tags.push('后端', 'FastAPI');
    if (desktop) tags.push('桌面', 'Electron');
    let projectType = '其他';
    if (front && back) projectType = '全栈项目';
    else if (desktop) projectType = '桌面应用';
    else if (back) projectType = '后端项目';
    else if (front) projectType = '前端项目';
    return { projectType, tags: [...new Set(tags)] };
  }
};

if (typeof module !== 'undefined' && module.exports) module.exports = COMPOSER_META;
