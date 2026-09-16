import { useEffect, useState } from 'react';
import { App, Badge, Button, Card, Empty, List, Space, Tag, Typography } from 'antd';
import { BellOutlined, NotificationOutlined } from '@ant-design/icons';
import { BATCH_STATUS_FLOW, BATCH_STATUS_LABEL } from '@zc/shared';
import { fetchActiveBatch, fetchAnnouncements, fetchNotifications, markNotificationRead } from '../../api';
import { BatchStatusTag, fmtTime } from '../../components/common';

/** 学生端首页：批次阶段时间线 + 公告 + 站内通知 */
export default function StudentHome() {
  const { message } = App.useApp();
  const [batch, setBatch] = useState<any>(null);
  const [announcements, setAnnouncements] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);

  const load = () => {
    fetchActiveBatch()
      .then((b) => {
        setBatch(b);
        if (b) return fetchAnnouncements(b.id);
        return [];
      })
      .then(setAnnouncements)
      .catch(() => undefined);
    fetchNotifications()
      .then(setNotifications)
      .catch(() => undefined);
  };
  useEffect(load, []);

  const currentIdx = batch ? BATCH_STATUS_FLOW.indexOf(batch.status) : -1;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card size="small" title="当前批次" extra={batch ? <BatchStatusTag status={batch.status} /> : null}>
        {batch ? (
          <>
            <Typography.Title level={5} style={{ marginBottom: 4 }}>
              {batch.name}
            </Typography.Title>
            <Typography.Text type="secondary">学期 {batch.semesterKey}</Typography.Text>
            <div className="zc-timeline">
              {BATCH_STATUS_FLOW.map((s, i) => (
                <div key={s} className={`zc-timeline-node ${i < currentIdx ? 'done' : ''} ${i === currentIdx ? 'current' : ''}`}>
                  <span className="zc-timeline-dot">{i + 1}</span>
                  <span className="zc-timeline-label">{BATCH_STATUS_LABEL[s]}</span>
                </div>
              ))}
            </div>
            {[0, 1].includes(currentIdx) ? (
              <Typography.Paragraph type="success" style={{ marginBottom: 0 }}>
                材料收集阶段：可在「提材料」中提交加分申请与电子版材料包
              </Typography.Paragraph>
            ) : currentIdx === 6 ? (
              <Typography.Paragraph type="warning" style={{ marginBottom: 0 }}>
                公示期：可在「查分」页查看成绩并提交异议
              </Typography.Paragraph>
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                当前阶段暂无需学生操作，请留意通知
              </Typography.Paragraph>
            )}
          </>
        ) : (
          <Empty description="暂无进行中的批次" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <NotificationOutlined />
            公告
          </Space>
        }
      >
        {announcements.length ? (
          <List
            size="small"
            dataSource={announcements}
            renderItem={(a) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      {a.pinned && <Tag color="red">置顶</Tag>}
                      <span>{a.title}</span>
                    </Space>
                  }
                  description={
                    <>
                      <div>{a.content}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(a.createdAt)}</Typography.Text>
                    </>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="暂无公告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <BellOutlined />
            我的通知
            <Badge count={notifications.filter((n) => !n.readAt).length} size="small" />
          </Space>
        }
      >
        {notifications.length ? (
          <List
            size="small"
            dataSource={notifications.slice(0, 10)}
            renderItem={(n) => (
              <List.Item
                actions={
                  n.readAt
                    ? undefined
                    : [
                        <Button
                          key="read"
                          type="link"
                          size="small"
                          onClick={() => markNotificationRead(n.id).then(load).catch(() => message.error('操作失败'))}
                        >
                          标记已读
                        </Button>,
                      ]
                }
              >
                <List.Item.Meta
                  title={<span style={{ fontWeight: n.readAt ? 400 : 600 }}>{n.title}</span>}
                  description={
                    <>
                      <div>{n.content}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(n.createdAt)}</Typography.Text>
                    </>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty description="暂无通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Card>
    </Space>
  );
}
