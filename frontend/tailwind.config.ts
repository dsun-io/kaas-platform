import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // 颜色令牌统一采用「通道三元组 + 透明度插槽」形式：
      //   定义侧  --primary: 0.48 0.19 278;
      //   映射侧  oklch(var(--primary) / <alpha-value>)
      // 只有带 <alpha-value> 占位符，Tailwind 才能注入透明度，
      // bg-primary/10、hover:bg-muted/40 这类写法才会真正生成样式。
      // （此前映射为 var(--primary)，Tailwind 无法注入透明度 → 整条类被静默跳过。）
      colors: {
        border: 'oklch(var(--border) / <alpha-value>)',
        input: 'oklch(var(--input) / <alpha-value>)',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)',
          muted: 'oklch(var(--destructive-muted) / <alpha-value>)',
          'muted-foreground': 'oklch(var(--destructive-muted-foreground) / <alpha-value>)',
        },
        // 语义状态色：成功 / 警告 / 信息。四种用法：
        //   text-success            文字/图标
        //   bg-success text-success-foreground        实底背景
        //   bg-success-muted text-success-muted-foreground  淡底标签/提示框
        // 均自带暗色模式取值，页面不要直接引用调色板。
        success: {
          DEFAULT: 'oklch(var(--success) / <alpha-value>)',
          foreground: 'oklch(var(--success-foreground) / <alpha-value>)',
          muted: 'oklch(var(--success-muted) / <alpha-value>)',
          'muted-foreground': 'oklch(var(--success-muted-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'oklch(var(--warning) / <alpha-value>)',
          foreground: 'oklch(var(--warning-foreground) / <alpha-value>)',
          muted: 'oklch(var(--warning-muted) / <alpha-value>)',
          'muted-foreground': 'oklch(var(--warning-muted-foreground) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'oklch(var(--info) / <alpha-value>)',
          foreground: 'oklch(var(--info-foreground) / <alpha-value>)',
          muted: 'oklch(var(--info-muted) / <alpha-value>)',
          'muted-foreground': 'oklch(var(--info-muted-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        sidebar: {
          DEFAULT: 'oklch(var(--sidebar) / <alpha-value>)',
          foreground: 'oklch(var(--sidebar-foreground) / <alpha-value>)',
          primary: 'oklch(var(--sidebar-primary) / <alpha-value>)',
          'primary-foreground': 'oklch(var(--sidebar-primary-foreground) / <alpha-value>)',
          accent: 'oklch(var(--sidebar-accent) / <alpha-value>)',
          'accent-foreground': 'oklch(var(--sidebar-accent-foreground) / <alpha-value>)',
          border: 'oklch(var(--sidebar-border) / <alpha-value>)',
          ring: 'oklch(var(--sidebar-ring) / <alpha-value>)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};

export default config;
