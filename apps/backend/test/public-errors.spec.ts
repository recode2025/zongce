import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { DUPLICATE_DATA_MESSAGE, OPERATION_FAILED_MESSAGE, publicErrorText, TASK_FAILED_MESSAGE } from '@zc/shared';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { publicExceptionMessage } from '../src/common/utils/public-error';
import { ImportsController } from '../src/modules/imports/imports.controller';
import { ExportsController } from '../src/modules/exports/exports.module';
import { JobService } from '../src/queue/job.service';

const trace = 'Invalid `this.prisma.courseGrade.createMany()` invocation in D:\\server\\dist\\grades-import.service.js:116:53\nUnique constraint failed on the fields: (`studentId`,`termKey`,`courseCode`,`examType`,`rawLineHash`)';

describe('对外错误信息', () => {
  afterEach(() => jest.restoreAllMocks());

  test('旧 Prisma 唯一键错误显示可操作提示，前端无需截断或悬停原文', () => {
    expect(publicErrorText(trace)).toBe(DUPLICATE_DATA_MESSAGE);
    expect(publicErrorText(['请检查数据', trace])).toBe(DUPLICATE_DATA_MESSAGE);
  });

  test.each([
    'SELECT passwordHash FROM User WHERE id = 1',
    'INSERT INTO CourseGrade VALUES (...)',
    'UPDATE CourseGrade SET score = 100',
    'DELETE FROM CourseGrade',
    'Error at import (D:\\server\\file.js:12:3)',
    'ENOENT /srv/app/config.env',
    'TypeError: Cannot read properties of undefined',
  ])('内部语句或路径不进入页面：%s', text => {
    expect(publicErrorText(text, TASK_FAILED_MESSAGE)).toBe(TASK_FAILED_MESSAGE);
  });

  test('正常业务校验保留，非受控异常不直接向客户端输出', () => {
    expect(publicExceptionMessage(new BadRequestException(['缺少学期', '请上传成绩表']))).toBe('缺少学期；请上传成绩表');
    expect(publicExceptionMessage(new Error('private database connection detail'))).toBe(OPERATION_FAILED_MESSAGE);
    expect(publicExceptionMessage(new BadRequestException(trace))).toBe(DUPLICATE_DATA_MESSAGE);
  });

  test.each(['development', 'production'])('%s 中 API 异常只输出安全信息，详情写入日志', mode => {
    const old = process.env.NODE_ENV;process.env.NODE_ENV = mode;
    try {
      const log=jest.spyOn(Logger.prototype,'error').mockImplementation();
      const json=jest.fn();const status=jest.fn().mockReturnValue({json});
      const host={switchToHttp:()=>({getResponse:()=>({status}),getRequest:()=>({method:'POST',url:'/api/v1/imports/confirm'})})};
      new AllExceptionsFilter().catch(new Error(trace),host as any);
      expect(status).toHaveBeenCalledWith(500);
      expect(json.mock.calls[0][0].message).toBe(OPERATION_FAILED_MESSAGE);
      expect(JSON.stringify(json.mock.calls)).not.toContain('courseGrade');
      expect(log.mock.calls[0][0]).toContain(trace);
    } finally { if(old===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=old; }
  });

  test('历史任务详情、导入列表、导出列表均过滤存量错误，不改原记录', async () => {
    const original={id:'old-failed-job',status:'FAILED',error:trace};
    const prisma={importJob:{findUnique:jest.fn().mockResolvedValue(original),findMany:jest.fn().mockResolvedValue([original])}};
    const imports=new ImportsController(prisma as any,{} as any,{} as any,{} as any,{} as any,{} as any);
    const exports=new ExportsController(prisma as any,{} as any,{} as any,{} as any);
    const superAdmin = { id: 'root', role: 'SUPER_ADMIN' } as any;
    for(const job of [await imports.job(original.id,superAdmin),...(await imports.listJobs('GRADE',undefined,superAdmin)),...(await exports.history(undefined,superAdmin))]){
      expect(job.error).toBe(DUPLICATE_DATA_MESSAGE);
      expect(JSON.stringify(job)).not.toContain('rawLineHash');
    }
    expect(original.error).toBe(trace);
  });

  test('异步失败只保存安全提示，完整异常仍可由日志追踪', async () => {
    const log=jest.spyOn(Logger.prototype,'error').mockImplementation();
    const update=jest.fn().mockResolvedValue({});
    const prisma={importJob:{findFirst:jest.fn().mockResolvedValue(null),create:jest.fn().mockResolvedValue({id:'test-job'}),update}};
    const error=Object.assign(new Error(trace),{code:'P2002'});
    await new JobService(prisma as any).start({kind:'GRADE',handler:async()=>{throw error;}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(update).toHaveBeenCalledWith({where:{id:'test-job'},data:{status:'FAILED',error:DUPLICATE_DATA_MESSAGE}});
    expect(log).toHaveBeenCalledWith(expect.stringContaining('test-job'),error.stack);
  });

  test('任务互斥仍返回可读的 409 提示', async () => {
    const prisma={importJob:{findFirst:jest.fn().mockResolvedValue({id:'running'})}};
    await expect(new JobService(prisma as any).start({kind:'GRADE',handler:async()=>({})})).rejects.toBeInstanceOf(ConflictException);
  });
});
