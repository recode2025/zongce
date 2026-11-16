import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Role } from '@zc/shared';
import { StudentsController } from '../src/modules/students/students.controller';
import { GradesController } from '../src/modules/grades/grades.controller';

const leader = { id: 'leader', role: Role.CLASS_LEADER, classId: 'class-a' } as any;
const admin = { id: 'admin', role: Role.GRADE_ADMIN, grade: 2025 } as any;
const unboundAdmin = { id: 'admin', role: Role.GRADE_ADMIN } as any;

test('学生列表强制本班或本年级，拒绝跨班请求和未绑定管理员', async () => {
  const student = { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
  const prisma = { student, $transaction: jest.fn((queries) => Promise.all(queries)) };
  const controller = new StudentsController(prisma as any, {} as any, {} as any);
  await expect(controller.list(leader, undefined, 'class-b')).rejects.toBeInstanceOf(ForbiddenException);
  await controller.list(leader);
  expect(student.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { classId: 'class-a' } }));
  await controller.list(admin, '2024');
  expect(student.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { grade: 2025 } }));
  await expect(controller.list(unboundAdmin)).rejects.toBeInstanceOf(ForbiddenException);
});

test('成绩明细先验证班级或年级，再查询课程', async () => {
  const prisma = { student: { findFirst: jest.fn().mockResolvedValue(null) }, batch: { findUnique: jest.fn() }, courseGrade: { findMany: jest.fn() } };
  const controller = new GradesController(prisma as any, {} as any, {} as any);
  await expect(controller.studentGrades(leader, 'other', 'batch')).rejects.toThrow(/无权查看/);
  expect(prisma.student.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other', classId: 'class-a' } }));
  expect(prisma.courseGrade.findMany).not.toHaveBeenCalled();
  await expect(controller.studentGrades(unboundAdmin, 'student', 'batch')).rejects.toBeInstanceOf(ForbiddenException);
});

test('单条学生更新、单条与批量成绩裁决均限定年级', async () => {
  const prisma = {
    student: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    gradeIssue: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const audit = { log: jest.fn() };
  const students = new StudentsController(prisma as any, audit as any, {} as any);
  const grades = new GradesController(prisma as any, audit as any, {} as any);
  await expect(students.patch('other', { name: 'name' }, admin, '')).rejects.toThrow(/无权修改/);
  expect(prisma.student.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other', grade: 2025 } }));
  await expect(grades.resolve('other', { resolution: 'EXCLUDED' } as any, admin, '')).rejects.toThrow(/无权处理/);
  expect(prisma.gradeIssue.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other', student: { grade: 2025 } } }));
  await grades.batchResolve({ batchId: 'b', resolution: 'EXCLUDED', ids: ['own', 'other'] }, admin, '');
  expect(prisma.gradeIssue.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['own', 'other'] }, student: { grade: 2025 } }) }));
});

test('班级列表及班委任命限定本班或本年级', async () => {
  const prisma = { clazz: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) }, student: { findFirst: jest.fn() } };
  const controller = new StudentsController(prisma as any, {} as any, {} as any);
  await controller.classes(undefined, leader);
  expect(prisma.clazz.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'class-a' } }));
  await expect(controller.bindLeader('other-class', { userId: 'target' }, admin, '')).rejects.toThrow(/无权修改/);
  expect(prisma.clazz.findFirst).toHaveBeenCalledWith({ where: { id: 'other-class', grade: 2025 } });
  expect(prisma.student.findFirst).not.toHaveBeenCalled();
});
