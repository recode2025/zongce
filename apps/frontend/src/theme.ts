import type { ThemeConfig } from 'antd';

/**
 * 设计体系「刻度」：藏青主色（取自校徽）+ 冷瓷灰底 + 三维度色（品德/学业/文体）作品牌强调。
 * 与 global.css 里 :root 的 --zc-* 变量一一对应——改色时两处同步。
 */
export const ZC = {
  primary: '#1b3769',
  primaryHover: '#284a85',
  primarySoft: '#edf1f8',
  accent: '#a8822f',
  success: '#2e7a4f',
  warning: '#b0690f',
  danger: '#b3261e',
  text: '#172033',
  text2: '#475266',
  text3: '#6b7588',
  bg: '#f1f3f6',
  surface2: '#f7f8fa',
  line: '#dfe3ea',
  lineSoft: '#eaedf2',
} as const;

/** 与 global.css 的 --ease-out / --ease-in-out 相同 */
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_IN_OUT = 'cubic-bezier(0.77, 0, 0.175, 1)';

const FONT =
  "'PingFang SC', 'Microsoft YaHei UI', 'Microsoft YaHei', 'Hiragino Sans GB', -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: ZC.primary,
    colorInfo: ZC.primary,
    colorLink: ZC.primaryHover,
    colorSuccess: ZC.success,
    colorWarning: ZC.warning,
    colorError: ZC.danger,
    colorTextBase: ZC.text,
    colorBgLayout: ZC.bg,
    colorBorder: '#d5dae3',
    colorBorderSecondary: ZC.lineSoft,
    colorFillAlter: ZC.surface2,
    borderRadius: 6,
    borderRadiusLG: 10,
    borderRadiusSM: 4,
    fontSize: 14,
    fontFamily: FONT,
    boxShadowTertiary: '0 1px 2px rgba(15, 34, 68, 0.05)',
    // 动效：统一收紧时长、换强 ease-out 曲线（弹窗/下拉/抽屉/消息都走这套）
    motionDurationFast: '0.12s',
    motionDurationMid: '0.18s',
    motionDurationSlow: '0.24s',
    motionEaseOut: EASE_OUT,
    motionEaseOutCirc: EASE_OUT,
    motionEaseOutQuint: EASE_OUT,
    motionEaseInOut: EASE_IN_OUT,
    // 语义浅底/边框直接指定：antd 默认从主色推算浅色，深色种子会推出发灰的底（标签、提示框、选中行都受影响）
    colorPrimaryBg: '#edf1f8',
    colorPrimaryBgHover: '#e1e8f4',
    colorPrimaryBorder: '#d3dcec',
    colorPrimaryBorderHover: '#b4c3dd',
    colorInfoBg: '#edf1f8',
    colorInfoBorder: '#d3dcec',
    colorSuccessBg: '#ebf6ef',
    colorSuccessBorder: '#bfe2cc',
    colorWarningBg: '#fdf4e4',
    colorWarningBorder: '#f1d6a6',
    colorErrorBg: '#fdeceb',
    colorErrorBorder: '#f3c4c0',
    // 预设色板：中等明度、不压暗（Tag 的具体配色在 global.css「标签与徽标」里逐色指定）
    blue: '#3a6fd8',
    geekblue: '#4060c8',
    purple: '#7a5cc4',
    cyan: '#1f98a3',
    green: '#2f9c62',
    lime: '#78a336',
    gold: '#c8962a',
    orange: '#d97f1a',
    volcano: '#d4603a',
    red: '#d6403a',
    magenta: '#c2478a',
  },
  components: {
    Layout: { headerBg: '#ffffff', siderBg: '#ffffff', bodyBg: ZC.bg, headerHeight: 56, headerPadding: '0 24px' },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: ZC.primarySoft,
      itemSelectedColor: ZC.primary,
      itemHoverBg: ZC.surface2,
      itemColor: ZC.text2,
      itemHeight: 38,
      itemBorderRadius: 6,
      itemMarginInline: 10,
      groupTitleColor: ZC.text3,
      groupTitleFontSize: 12,
      activeBarBorderWidth: 0,
      iconSize: 15,
    },
    Card: { headerFontSize: 15, headerFontSizeSM: 14, headerHeightSM: 46 },
    Table: {
      headerBg: ZC.surface2,
      headerColor: ZC.text2,
      headerSplitColor: 'transparent',
      rowHoverBg: '#f5f7fb',
      borderColor: ZC.lineSoft,
      headerSortActiveBg: '#eef1f5',
    },
    Button: { primaryShadow: 'none', defaultShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
    Tag: { defaultBg: ZC.surface2, defaultColor: ZC.text2 },
    // 数字角标：亮红，不用偏暗的错误色
    Badge: { colorError: '#e5484d' },
    Descriptions: { labelBg: ZC.surface2 },
    Segmented: { itemSelectedColor: ZC.primary },
    Tabs: { itemSelectedColor: ZC.primary, inkBarColor: ZC.primary },
    Statistic: { titleFontSize: 13 },
    Modal: { titleFontSize: 16 },
  },
};
