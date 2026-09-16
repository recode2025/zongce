import { Select, Table, Tag } from 'antd';

export interface MappingRow {
  target: string;
  label: string;
  required?: boolean;
  source?: string;
}

/** 列映射确认表：系统已按别名表建议，人工可逐列改选源列 */
export function MappingTable({
  headers,
  mapping,
  onChange,
}: {
  headers: string[];
  mapping: MappingRow[];
  onChange: (m: MappingRow[]) => void;
}) {
  return (
    <Table
      size="small"
      rowKey="target"
      pagination={false}
      dataSource={mapping}
      locale={{ emptyText: '无映射目标' }}
      columns={[
        {
          title: '系统字段',
          dataIndex: 'label',
          width: 180,
          render: (v: string, r) => (
            <>
              {v} {r.required ? <Tag color="red">必填</Tag> : <Tag>选填</Tag>}
            </>
          ),
        },
        {
          title: '源列（Excel 表头）',
          dataIndex: 'source',
          render: (v: string | undefined, r) => (
            <Select
              style={{ width: 240 }}
              value={v}
              allowClear
              showSearch
              placeholder={r.required ? '必须选择' : '可不选'}
              status={r.required && !v ? 'error' : undefined}
              options={headers.map((h) => ({ value: h, label: h }))}
              onChange={(nv) => onChange(mapping.map((m) => (m.target === r.target ? { ...m, source: nv || undefined } : m)))}
            />
          ),
        },
        {
          title: '状态',
          width: 110,
          render: (_, r) =>
            r.required ? (r.source ? <Tag color="success">已就绪</Tag> : <Tag color="error">缺失</Tag>) : r.source ? <Tag color="processing">已选</Tag> : <Tag>未选</Tag>,
        },
      ]}
    />
  );
}
