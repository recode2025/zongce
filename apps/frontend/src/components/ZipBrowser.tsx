import { useEffect, useState } from 'react';
import { App, Button, Empty, List, Spin, Tag, Typography } from 'antd';
import { DownloadOutlined, EyeOutlined, FileOutlined, FileImageOutlined, FilePdfOutlined } from '@ant-design/icons';
import { downloadFile, fetchZipEntries, fetchZipPreviewBlobUrl } from '../api';
import { errMsg } from '../api/client';
import { fileSize } from './common';

/**
 * 压缩包在线浏览抽屉内容：目录清单 + 单文件懒解压内联预览（pdf/图片）。
 * 后端仅解压被点击的条目（沙箱白名单），前端以 blob URL 呈现。
 */
export default function ZipBrowser({ uuid, zipName }: { uuid: string; zipName?: string }) {
  const { message } = App.useApp();
  const [entries, setEntries] = useState<{ path: string; name: string; size: number; previewable: boolean; status: string }[] | null>(null);
  const [preview, setPreview] = useState<{ url: string; name: string; isImg: boolean } | null>(null);
  const [loadingPath, setLoadingPath] = useState<string>('');

  useEffect(() => {
    setEntries(null);
    setPreview(null);
    fetchZipEntries(uuid)
      .then(setEntries)
      .catch((e) => {
        message.error(errMsg(e));
        setEntries([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid]);

  const openPreview = async (path: string) => {
    setLoadingPath(path);
    try {
      const url = await fetchZipPreviewBlobUrl(uuid, path);
      const isImg = /\.(png|jpe?g|webp)$/i.test(path);
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { url, name: path.split('/').pop() ?? path, isImg };
      });
    } catch (e) {
      message.error(errMsg(e));
    } finally {
      setLoadingPath('');
    }
  };

  if (!entries) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin tip="读取压缩包目录…" />
      </div>
    );
  }
  if (!entries.length) return <Empty description="压缩包内没有文件（或目录解析失败）" />;

  return (
    <div className="zc-zipbrowser">
      <div className="zc-zip-list">
        <Typography.Text strong type="secondary" style={{ fontSize: 12 }}>
          包内 {entries.length} 个文件{zipName ? ` · ${zipName}` : ''}
        </Typography.Text>
        <List
          size="small"
          dataSource={entries}
          renderItem={(e) => (
            <List.Item
              style={{ padding: '6px 4px' }}
              actions={[
                e.previewable ? (
                  <Button
                    key="view"
                    type="link"
                    size="small"
                    icon={<EyeOutlined />}
                    loading={loadingPath === e.path}
                    onClick={() => openPreview(e.path)}
                  >
                    预览
                  </Button>
                ) : (
                  <Tag key="no" style={{ marginInlineEnd: 0 }}>
                    不支持预览
                  </Tag>
                ),
              ]}
            >
              <List.Item.Meta
                avatar={/\.(png|jpe?g|webp)$/i.test(e.name) ? <FileImageOutlined /> : /\.(pdf)$/i.test(e.name) ? <FilePdfOutlined /> : <FileOutlineIcon />}
                title={<Typography.Text style={{ fontSize: 13 }} ellipsis={{ tooltip: e.path }}>{e.name}</Typography.Text>}
                description={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.path} · {fileSize(e.size)}</Typography.Text>}
              />
            </List.Item>
          )}
        />
        <Button block icon={<DownloadOutlined />} onClick={() => downloadFile(uuid, zipName ?? '材料包.zip')} style={{ marginTop: 8 }}>
          下载完整压缩包
        </Button>
      </div>
      {preview && (
        <div className="zc-zip-preview">
          {preview.isImg ? (
            <img src={preview.url} alt={preview.name} className="zc-preview-img" />
          ) : (
            <iframe title={preview.name} src={preview.url} className="zc-preview-frame" />
          )}
        </div>
      )}
    </div>
  );
}

const FileOutlineIcon = () => <FileOutlined />;
