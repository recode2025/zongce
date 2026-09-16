import { useEffect, useRef, useState } from 'react';
import { Alert, Progress, Space, Typography } from 'antd';
import { ImportJob, fetchJob } from '../api';

/** 导入/计算/导出任务进度轮询（后端接口即返 jobId，前端 1s 轮询） */
export default function JobProgress({
  jobId,
  onDone,
  onFail,
}: {
  jobId: string;
  onDone?: (job: ImportJob) => void;
  onFail?: (job: ImportJob | null) => void;
}) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await fetchJob(jobId);
        if (!alive) return;
        setJob(j);
        if (j.status === 'DONE' && !fired.current) {
          fired.current = true;
          onDone?.(j);
          return;
        }
        if (j.status === 'FAILED' && !fired.current) {
          fired.current = true;
          onFail?.(j);
          return;
        }
        timer = setTimeout(poll, 1000);
      } catch {
        if (alive) timer = setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  if (!job) return <Progress percent={0} status="active" />;
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Progress
        percent={job.progress ?? 0}
        status={job.status === 'FAILED' ? 'exception' : job.status === 'DONE' ? 'success' : 'active'}
      />
      {job.status === 'FAILED' && <Alert type="error" showIcon message="任务失败" description={job.error ?? '未知错误'} />}
      {job.status === 'DONE' && job.summary && (
        <Alert
          type="success"
          showIcon
          message="任务完成"
          description={<Typography.Text code>{JSON.stringify(job.summary)}</Typography.Text>}
        />
      )}
      <Typography.Text type="secondary">
        任务 {job.id.slice(0, 8)}… · {job.status}
      </Typography.Text>
    </Space>
  );
}
