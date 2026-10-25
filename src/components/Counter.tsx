// 起步模板：React 组件示例（当前未被任何页面引用，可删除或改造）。
// 在 .astro 页面中使用：import Counter from '../components/Counter.tsx';
// 并加 client 指令来开启水合：<Counter client:load /> / client:visible / client:idle
import { useState } from 'react';

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      onClick={() => setCount((c) => c + 1)}
      style={{
        padding: '0.5rem 1rem',
        fontSize: '1rem',
        cursor: 'pointer',
        borderRadius: '0.5rem',
        border: '1px solid #888',
        background: '#f5f5f5',
      }}
    >
      Clicked {count} {count === 1 ? 'time' : 'times'}
    </button>
  );
}
