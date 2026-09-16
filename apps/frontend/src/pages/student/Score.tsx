import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Card, Col, Descriptions, Empty, Input, List, Modal, Row, Space, Statistic, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { fetchActiveBatch, fetchMyObjections, fetchMyScore, submitObjection } from '../../api';
import { errMsg } from '../../api/client';
import { FlagTag, fmtTime } from '../../components/common';
import ScoreBreakdown from '../../components/ScoreBreakdown';

const OBJECTION_STATUS: Record<string, { color: string; text: string }> = {
  SUBMITTED: { color: 'processing', text: '待处理' },
  ACCEPTED: { color: 'success', text: '已受理·将更正' },
  REJECTED: { color: 'default', text: '不成立' },
};

/** 学生查分：快照直达（发布物化），总分 + 三维明细 + 排名 + 公示期内可提异议 */
export default function MyScore() {
  const { message } = App.useApp();
  const [score, setScore] = useState<any>(null);
  const [objections, setObjections] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    fetchMyScore()
      .then((s) => {
        setScore(s);
        setErr('');
      })
      .catch((e) => setErr(errMsg(e)));
    fetchMyObjections()
      .then(setObjections)
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  const publicityActive = score?.publicityEnd && new Date(score.publicityEnd).getTime() > Date.now();
  const dim = (label: string, d: any, max: number, rows: [string, string, number][]) => (
    <Card size="small">
      <Statistic
        title={label}
        value={d?.total ?? '-'}
        suffix={`/ ${max}`}
        precision={2}
        valueStyle={{ color: '#2f54eb' }}
      />
      <Descriptions size="small" column={1} style={{ marginTop: 8 }}>
        {rows.map(([k, name, v]) => (
          <Descriptions.Item key={k} label={name}>
            <span className="zc-num">{v != null ? Number(v).toFixed(2) : '-'}</span>
          </Descriptions.Item>
        ))}
      </Descriptions>
    </Card>
  );

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {err && !score && (
        <Card size="small">
          <Empty description={err} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </Card>
      )}

      {score && (
        <>
          <Card size="small" className="zc-score-hero">
            <Row gutter={[12, 12]} align="middle">
              <Col xs={12} sm={8}>
                <Statistic title="综合素质测评总分" value={score.totalScore} precision={2} valueStyle={{ fontSize: 34, fontWeight: 700 }} />
              </Col>
              <Col xs={12} sm={8}>
                {score.rankHidden ? (
                  <>
                    <Statistic title="年级排名" value="不公示" valueStyle={{ fontSize: 22 }} />
                    <Statistic title="班级排名" value="不公示" valueStyle={{ fontSize: 16 }} />
                  </>
                ) : (
                  <>
                    <Statistic title="年级排名" value={score.rankGrade ?? '-'} suffix="名" />
                    <Statistic title="班级排名" value={score.rankClass ?? '-'} suffix="名" valueStyle={{ fontSize: 18 }} />
                  </>
                )}
              </Col>
              <Col xs={24} sm={8} style={{ textAlign: 'right' }}>
                <Space direction="vertical" size={2}>
                  <Tag color="purple">第 {score.round} 轮公示 · v{score.calcVersion}</Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {score.className} · {score.name}（{score.studentNo}）
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    公示期至 {fmtTime(score.publicityEnd)}
                  </Typography.Text>
                </Space>
              </Col>
            </Row>
          </Card>

          <Row gutter={[12, 12]}>
            <Col xs={24} sm={8}>
              {dim('品德行为（15）', score.moral, 15, [
                ['base', '基础分', score.moral?.base],
                ['bonus', '奖扣分合计', score.moral?.bonus],
              ])}
            </Col>
            <Col xs={24} sm={8}>
              {dim('学业表现（75）', score.academic, 75, [
                ['w', '加权成绩', score.academic?.weighted],
                ['a', '全科加分', score.academic?.allPass],
                ['b', '奖项加分', score.academic?.bonus],
                ['f', '不及格扣分', score.academic?.failPenalty],
              ])}
            </Col>
            <Col xs={24} sm={8}>
              {dim('文体表现（10）', score.sports, 10, [
                ['base', '基础分', score.sports?.base],
                ['c', '学生干部', score.sports?.cadre],
                ['at', '文体活动总分', score.sports?.activityTotal],
              ])}
            </Col>
          </Row>

          {!!score.flags?.length && (
            <Alert
              type="warning"
              showIcon
              message="标记提示"
              description={<Space wrap>{score.flags.map((f: string) => <FlagTag key={f} flag={f} />)}</Space>}
            />
          )}

          <Card size="small" title="计算明细（可解释）">
            <ScoreBreakdown breakdown={score.breakdown} courseSummary={score.courseSummary} />
          </Card>
        </>
      )}

      <Card
        size="small"
        title="成绩异议"
        extra={
          publicityActive && (
            <Button type="primary" size="small" onClick={() => setModalOpen(true)}>
              提交异议
            </Button>
          )
        }
      >
        {!publicityActive && (
          <Typography.Text type="secondary">异议仅可在公示期内提交（本轮公示{score?.publicityEnd ? `至 ${fmtTime(score.publicityEnd)}` : '已结束'}）</Typography.Text>
        )}
        {objections.length > 0 && (
          <List
            size="small"
            style={{ marginTop: 12 }}
            dataSource={objections}
            renderItem={(o) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space size={6}>
                      <Tag color={OBJECTION_STATUS[o.status]?.color}>{OBJECTION_STATUS[o.status]?.text ?? o.status}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtTime(o.createdAt)}</Typography.Text>
                    </Space>
                  }
                  description={
                    <>
                      <div>{o.content}</div>
                      {o.handleNote && <Typography.Text type="secondary">处理意见：{o.handleNote}</Typography.Text>}
                    </>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Modal
        title="提交成绩异议"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={async () => {
          if (content.trim().length < 10) {
            message.warning('异议说明至少 10 个字');
            return;
          }
          setSubmitting(true);
          try {
            const batch = await fetchActiveBatch().catch(() => null);
            await submitObjection({ batchId: score?.batchId ?? batch?.id, content: content.trim() });
            message.success('异议已提交，等待辅导员处理');
            setModalOpen(false);
            setContent('');
            load();
          } catch (e) {
            message.error(errMsg(e));
          } finally {
            setSubmitting(false);
          }
        }}
        confirmLoading={submitting}
        okText="提交"
      >
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message="请具体说明异议项（如：某课程成绩、某加分项分值），处理结果将通过通知告知"
        />
        <Input.TextArea rows={5} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} showCount placeholder="至少 10 个字，最多 2000 字" />
      </Modal>
    </Space>
  );
}
