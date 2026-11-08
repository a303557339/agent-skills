# 接入已有页面

## 文件和入口

将 `assets/cursor-swarm.mjs`、`assets/swarm-motion.mjs`、`assets/swarm-choreography.mjs` 一起复制到项目中，例如 `public/effects/`。三个文件保持同级；入口文件会导入群体运动与工作动作模块。

静态 HTML，在主体 DOM 创建之后挂载：

```html
<main id="page">
  <h1 data-swarm="text">把原本的标题留下来</h1>
  <article data-swarm="rect" data-swarm-id="card">
    <h2 data-swarm="text" data-swarm-after="card">先拉框，再打字</h2>
    <p data-swarm="text" data-swarm-after="card">原有内容与事件不需要重写。</p>
  </article>
  <svg viewBox="0 0 200 80" aria-hidden="true">
    <path data-swarm="path" d="M10 60 Q100 -20 190 60"
      fill="none" stroke="currentColor" stroke-width="2" />
  </svg>
</main>
<script type="module">
  import { createCursorSwarm } from '/effects/cursor-swarm.mjs';
  const swarm = createCursorSwarm({
    root: document.querySelector('#page'),
    start: 'auto',
    count: 36,
    workers: 'auto',
    autoDiscover: false,
  });
  // 与项目已有控制组件连接：swarm.replay() / swarm.finish()
</script>
```

保留所有原有文案、标签和事件。文字效果以裁剪显现原始文本，不逐字改写 `textContent`；这样 React／Vue 无需放弃 DOM 所有权。未加载或未挂载动效时，页面内容仍应正常显示，不要在全局 CSS 里预先隐藏全部目标。

## 目标标注

| 标注 | 用途与选择原则 |
| --- | --- |
| `data-swarm="text"` | 标题、短段落、标签。用在能单独施工的文本元素上；长文档无需每段都动画。 |
| `data-swarm="rect"` | 卡片、按钮、面板的拖框显现。子文字若单独动画，应依赖父目标。 |
| `data-swarm="path"` | 有描边的 SVG `<path>`。光标沿真实几何路径运动；复杂整幅 SVG 可用 `reveal`。 |
| `data-swarm="reveal"` | 图片、复杂组件、视频封面等保持内部行为的区域显现。 |
| `data-swarm-id="card"` | 稳定且在当前实例内唯一的任务 ID。 |
| `data-swarm-after="card heading"` | 前置任务 ID，以空格分隔。仅在这些任务完成后开始。不要产生循环或引用不存在的 ID。 |
| `data-swarm-ignore` | 排除整个子树，例如固定工具条、验证码、富文本编辑器。 |

一个元素只标一种任务。不要把整页标为 `rect` 再让所有后代一起施工。需要父子动画时，用父背景／容器和少量子文字表达清晰依赖；否则选不重叠的叶子区域。

未明确标注时，`autoDiscover: true` 会从常见 `h1/h2/h3/p/button/a/img/svg` 中选择目标并避免一般嵌套。它适合快速试用；复杂嵌套、仪表盘和交互组件应显式标注，并设 `autoDiscover: false`。

## 配置与实例

```js
const swarm = createCursorSwarm({
  root: document.body,
  count: 36,
  workers: 'auto',
  start: 'auto',
  intro: false,
  autoDiscover: true,
  radius: 115,
  speed: 1,
  respectReducedMotion: true,
  touch: 'disable',
});
```

| 选项 | 含义 |
| --- | --- |
| `root` | 目标所在 DOM 根节点，默认 `document.body`。固定控制栏最好放在根节点之外。 |
| `count` | 光标数量上限及最终跟随群规模，默认 36。施工中按需求增减，不要求始终显示这么多光标。 |
| `workers` | 默认 `'auto'`，根据工作需求动态招募，最多到 `count`。设为数字时保留明确的施工并发上限；空闲光标独立待命。 |
| `start` | `auto` 自动开始；`interaction` 等待交互触发；`manual` 由 `start()` 控制。 |
| `intro` | 是否启用开场环绕阶段，默认 `false`。需要原站式开场时配合 `start: 'interaction'`。 |
| `autoDiscover` | 自动发现常见内容元素，默认 `true`。 |
| `radius` | 跟随环绕尺度，单位为 CSS 像素，默认 115。 |
| `speed` | 施工节奏倍率，默认 1。 |
| `respectReducedMotion` | 默认 `true`，减少动态效果偏好开启时跳过动画。 |
| `touch` | 默认 `'disable'`，粗指针／触屏环境不启动动效。 |

实例提供：

- `start()`：开始施工。
- `replay()`：重新播放。
- `finish()`：立即完成目标显现。
- `refresh()`：重新发现目标；适合异步内容加载后调用。
- `destroy()`：停止动画、清理监听与覆盖层，恢复动效拥有的样式。
- `getState()`：返回 `phase`、`total`、`done`、`active`、`pending`、`cursorCount`，可用于调试或演示控件。
- `getState({ detailed: true })`：在汇总字段之外返回 `cursors` 快照，每个光标包含 `id`、`x`、`y`、`mode`、`tool`、`taskId`、`stage`、`worked`。用于观察参与分配和动作阶段，不应修改快照来控制动画。

阶段值为 `intro`、`building`、`following`、`reduced`、`destroyed`。下方尚未进入施工范围的目标可以保持等待，因此不要只根据当前视口空闲就判定整页已经完工。

## 施工和游走的节奏

默认开场约 18 个光标，受 `count` 上限约束。开始施工后，工人按区域、距离和参与次数领取任务；一个任务依次经过 `travel`、`press`、`work`、`review`，完成后光标再撤离。文字工具停在工作区域附近，插入点随实际输入前进，标点和词间有独立停顿。

当前可见任务耗尽时，多余工人渐渐离场，保留约 6 个独立游走的光标，另可能短暂存在尚在离场的个体；若 `count` 更小则按其上限。滚动到新区域后重新从边缘招募。只在所有页面任务完成之后，光标才重新集合、补足 `count` 并跟随真实鼠标。

这段行为属于核心体验。页面尚有待办区域时，不要把空闲光标送入鼠标中心的 flock；也不要把自动招募改成固定几个工人而不检查视觉影响。需要节制画面时，优先减少 `count` 或指定数字 `workers`，保留工作、独立游走、最终聚群的状态分工。

## React / Next.js

入口必须在客户端执行。若使用 Next.js，组件首行保留 `'use client'`。动态导入和取消标志处理卸载前尚未完成的模块加载；`destroy()` 也支持开发模式的挂载／卸载周期。

```jsx
'use client';
import { useEffect, useRef } from 'react';

export function Page() {
  const root = useRef(null);
  useEffect(() => {
    let cancelled = false;
    let swarm;
    import('../effects/cursor-swarm.mjs').then(({ createCursorSwarm }) => {
      if (!cancelled && root.current) {
        swarm = createCursorSwarm({ root: root.current, autoDiscover: false });
      }
    });
    return () => { cancelled = true; swarm?.destroy(); };
  }, []);
  return <main ref={root}><h1 data-swarm="text">Existing page title</h1></main>;
}
```

此例假设三个文件放在可供打包器导入的 `src/effects/`。如果放在 `public/effects/`，根据项目静态资源路径加载，不要把 `public` 当作普通源码相对路径。

## Vue

```vue
<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
const root = ref(null);
let swarm;
let cancelled = false;
onMounted(async () => {
  const { createCursorSwarm } = await import('../effects/cursor-swarm.mjs');
  if (!cancelled && root.value) {
    swarm = createCursorSwarm({ root: root.value, autoDiscover: false });
  }
});
onBeforeUnmount(() => { cancelled = true; swarm?.destroy(); });
</script>
<template>
  <main ref="root"><h1 data-swarm="text">Existing page title</h1></main>
</template>
```

组件内部的普通业务状态、事件和 `v-model` 保持原样。运行时监听新增／删除子节点并安排目标刷新，字体载入或尺寸变化时重新测量；大批量内容更新结束后也可主动调用 `refresh()`。

## 验证重点

先用演示页确认核心能运行，再验证实际目标页面。检查：开场光标群、群体施工、第一屏做完后的独立游走、滚动后的补充招募和最终跟随；文字换行、SVG 曲线、缩放后的光标对位；真实链接点击、键盘聚焦和表单提交；连续重播、销毁与重新挂载。

可用详细快照辅助确认：`building` 且 `pending > 0` 时不应出现 `mode: 'flock'`；等待新区域时应看到 `roam` 或尚在撤离的个体，而不是一团鼠标中心的装饰光标。用足够多的独立任务检查，实际参与工作的 ID 应随调度变化。仍需观看真实运动；状态字段不能证明动作观感已经达到参考效果。

聚焦或点击施工中的目标时应跳过其动画，让真实控件及时可用。减少动态效果与粗指针默认显示完整内容。浏览器标签页隐藏／恢复后，光标应保持有限速度且页面不被遗留裁剪。

全屏顶层模态框、跨域 iframe、封闭 Shadow DOM 和画布内部内容不属于普通 DOM 目标范围。遇到特殊区域，用显式目标、`reveal` 或排除标注处理；不要声称仅凭第三方网址就能永久修改该站。
