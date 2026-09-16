import { computeStudent, dedupCourses, rankAll, EngineCourse, DEFAULT_ENGINE_OPTIONS } from '../src/modules/calc/engine';

const course = (o: Partial<EngineCourse> & { courseCode: string; courseName: string; credit: number; scoreValue: number | null }): EngineCourse => ({
  id: o.courseCode,
  scoreFlag: '',
  scoreText: '',
  examType: '期末考试',
  courseAttr: '必修',
  courseNature: '专业必修课',
  isPublicElective: false,
  ...o,
} as EngineCourse);

describe('综测计算引擎（口径单测）', () => {
  test('舍入口径：65.8469…×0.75 → 65.85（ROUND_HALF_UP 2 位，模板实测）', () => {
    // 加权均分 87.7959…：85×4.5 + 92×2 → (382.5+184)/6.5 = 87.3077? 构造精确用例：
    // 目标加权均分 87.795918…：两门课 3 学分 95 + 4.5 学分 84.5 → (285+380.25)/7.5 = 88.7
    // 直接用模板原值：weightedAvg = 65.85/0.75 = 87.8 → 87.8×0.75 = 65.85
    const r = computeStudent({ id: 's1', enrollStatus: 'NORMAL' }, [course({ courseCode: 'C1', courseName: '课1', credit: 2, scoreValue: 85 }), course({ courseCode: 'C2', courseName: '课2', credit: 4.5, scoreValue: 89 })], [], DEFAULT_ENGINE_OPTIONS);
    // (85×2 + 89×4.5)/6.5 = (170+400.5)/6.5 = 87.7692… → ×0.75 = 65.8269… → 65.83
    expect(r.academicWeighted).toBe(65.83);
    expect(r.courseSummary.weightedAvg).toBe(87.77); // summary 口径为 round2 后展示值
  });

  test('公选课/学分0/缺考剔除加权；必修缺考计扣分', () => {
    const r = computeStudent(
      { id: 's1', enrollStatus: 'NORMAL' },
      [
        course({ courseCode: 'PE1', courseName: '体育(一)', credit: 1, scoreValue: 90, courseNature: '公共必修课', courseAttr: '必修' }),
        course({ courseCode: 'M1', courseName: '高数', credit: 4, scoreValue: 70 }),
        course({ courseCode: 'E1', courseName: '影视鉴赏', credit: 2, scoreValue: 100, courseNature: '公共选修课', courseAttr: '任选', isPublicElective: true }),
        course({ courseCode: 'Z1', courseName: '讲座', credit: 0, scoreValue: 95 }),
        course({ courseCode: 'F1', courseName: '大学英语', credit: 3, scoreValue: null, scoreFlag: '缺考' }),
      ],
      [],
      DEFAULT_ENGINE_OPTIONS,
    );
    // 参与加权：体育90×1 + 高数70×4 = 370/5 = 74 → 74×0.75 = 55.5
    expect(r.academicWeighted).toBe(55.5);
    // 体育课基础分 = 90/100×3 = 2.7
    expect(r.sportsBase).toBe(2.7);
    // 必修缺考 -1
    expect(r.academicFailPenalty).toBe(1);
    // 全科加分：无（70 < 80）
    expect(r.academicAllPass).toBe(0);
    expect(r.courseSummary.excluded.map((e) => e.reason)).toEqual(expect.arrayContaining(['公共选修课不计入加权', '学分为0', '缺考，无成绩']));
  });

  test('专业选修课（属性=任选）计入加权（golden：IT英语两例实证）；等级制「优」=95 兜底映射', () => {
    const r = computeStudent(
      { id: 's1', enrollStatus: 'NORMAL' },
      [
        course({ courseCode: 'SO1', courseName: 'IT英语', credit: 2, scoreValue: 80, courseNature: '专业选修课', courseAttr: '任选' }),
        course({ courseCode: 'SA1', courseName: '军事技能', credit: 2, scoreValue: null, scoreText: '优', courseNature: '公共必修课', courseAttr: '必修' }),
      ],
      [],
      DEFAULT_ENGINE_OPTIONS,
    );
    // (80×2 + 95×2)/4 = 87.5 → ×0.75 = 65.625 → 65.63
    expect(r.academicWeighted).toBe(65.63);
    expect(r.courseSummary.excluded).toEqual([]); // 任选专业课与等级制成绩均未被剔除
  });

  test('体育与健康不折算文体基础分；体育(一)专项课按成绩折算', () => {
    const health = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [course({ courseCode: 'PE1201', courseName: '体育与健康', credit: 1, scoreValue: 60, courseNature: '公共必修课', courseAttr: '限选' })],
      [],
      DEFAULT_ENGINE_OPTIONS,
    );
    expect(health.sportsBase).toBe(3); // golden：全班 W=3

    const special = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [course({ courseCode: 'PE101', courseName: '体育(一)', credit: 1, scoreValue: 95, courseNature: '公共必修课', courseAttr: '必修' })],
      [],
      DEFAULT_ENGINE_OPTIONS,
    );
    expect(special.sportsBase).toBe(2.85); // 95/100×3
  });

  test('全科 85+ → +2；80+ → +1；判定含公选课成绩（golden：公选73→0、83/84→1）', () => {
    const base = [
      course({ courseCode: 'A', courseName: 'a', credit: 3, scoreValue: 86 }),
      course({ courseCode: 'B', courseName: 'b', credit: 3, scoreValue: 90 }),
    ];
    expect(computeStudent({ id: 's', enrollStatus: 'NORMAL' }, base, [], DEFAULT_ENGINE_OPTIONS).academicAllPass).toBe(2);
    const mid = [course({ courseCode: 'A', courseName: 'a', credit: 3, scoreValue: 80 }), course({ courseCode: 'B', courseName: 'b', credit: 3, scoreValue: 90 })];
    expect(computeStudent({ id: 's', enrollStatus: 'NORMAL' }, mid, [], DEFAULT_ENGINE_OPTIONS).academicAllPass).toBe(1);

    // 公选课不计加权，但拉低全科判定（250460101/102/130 三例实证）
    const withLowElective = [...base, course({ courseCode: 'E', courseName: '网课', credit: 1, scoreValue: 73, courseNature: '公共选修课', courseAttr: '公选', isPublicElective: true })];
    expect(computeStudent({ id: 's', enrollStatus: 'NORMAL' }, withLowElective, [], DEFAULT_ENGINE_OPTIONS).academicAllPass).toBe(0);
    const withMidElective = [...base, course({ courseCode: 'E', courseName: '网课', credit: 1, scoreValue: 83, courseNature: '公共选修课', courseAttr: '公选', isPublicElective: true })];
    expect(computeStudent({ id: 's', enrollStatus: 'NORMAL' }, withMidElective, [], DEFAULT_ENGINE_OPTIONS).academicAllPass).toBe(1);
  });

  test('补考去重：优先期末考试行', () => {
    const { picked, autoPicked } = dedupCourses([
      course({ courseCode: 'C1', courseName: '高数', credit: 4, scoreValue: 45, examType: '期末考试' }),
      course({ courseCode: 'C1', courseName: '高数', credit: 4, scoreValue: 80, examType: '补考' }),
    ]);
    expect(autoPicked).toBe(false);
    expect(picked[0].scoreValue).toBe(45); // 第一次（期末）成绩为准
  });

  test('只有补考行时取最高分 + AUTO flag', () => {
    const { picked, autoPicked } = dedupCourses([
      course({ courseCode: 'C1', courseName: '高数', credit: 4, scoreValue: 45, examType: '补考' }),
      course({ courseCode: 'C1', courseName: '高数', credit: 4, scoreValue: 80, examType: '补考' }),
    ]);
    expect(autoPicked).toBe(true);
    expect(picked[0].scoreValue).toBe(80);
  });

  test('品德：基础9 + 封顶15 + 不足9 flag', () => {
    const r = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [],
      [
        { id: 'a1', ruleCode: 'MORAL_BLOOD', category: 'MORAL', grantedScore: 1 },
        { id: 'a2', ruleCode: 'MORAL_OTHER', category: 'MORAL', grantedScore: 7 },
      ],
      DEFAULT_ENGINE_OPTIONS,
    );
    expect(r.moralTotal).toBe(15); // 9+8=17 → 封顶
    expect(r.flags).toContain('CAPOUT_MORAL_15');

    const bad = computeStudent({ id: 's', enrollStatus: 'NORMAL' }, [], [{ id: 'a1', ruleCode: 'MORAL_OTHER', category: 'MORAL', grantedScore: -2 }], DEFAULT_ENGINE_OPTIONS);
    expect(bad.moralTotal).toBe(7);
    expect(bad.flags).toContain('BELOW_MORAL_9');
  });

  test('takeHighest：实践志愿多活动取最高档', () => {
    const r = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [],
      [
        { id: 'a1', ruleCode: 'MORAL_PRACTICE_VOLUNTEER', category: 'MORAL', grantedScore: 1 },
        { id: 'a2', ruleCode: 'MORAL_PRACTICE_VOLUNTEER', category: 'MORAL', grantedScore: 2 },
      ],
      { ...DEFAULT_ENGINE_OPTIONS, ruleCaps: { MORAL_PRACTICE_VOLUNTEER: { takeHighest: true, perTermMax: 2 } } },
    );
    expect(r.moralBonusByRule.MORAL_PRACTICE_VOLUNTEER).toBe(2); // 非累加 3
  });

  test('文体：干部取最高≤3，活动小计≤4，总分封顶10', () => {
    const r = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [course({ courseCode: 'PE', courseName: '体育(一)', credit: 1, scoreValue: 80, courseNature: '公共必修课' })],
      [
        { id: 'a1', ruleCode: 'SPORTS_CADRE', category: 'SPORTS', grantedScore: 3 },
        { id: 'a2', ruleCode: 'SPORTS_EVENT', category: 'SPORTS', grantedScore: 1.5 },
        { id: 'a3', ruleCode: 'SPORTS_CAMPUS', category: 'SPORTS', grantedScore: 0.5 },
        { id: 'a4', ruleCode: 'SPORTS_JOURNAL', category: 'SPORTS', grantedScore: 1 },
      ],
      { ...DEFAULT_ENGINE_OPTIONS, ruleCaps: { SPORTS_CADRE: { takeHighest: true, perTermMax: 3 } } },
    );
    // 基础 = 80/100×3 = 2.4；干部 3；活动 1.5+0.5+1=3 → 总 8.4 ≤ 10
    expect(r.sportsBase).toBe(2.4);
    expect(r.sportsCadre).toBe(3);
    expect(r.sportsActivityTotal).toBe(3);
    expect(r.sportsTotal).toBe(8.4);
  });

  test('学业封顶 75', () => {
    const r = computeStudent(
      { id: 's', enrollStatus: 'NORMAL' },
      [course({ courseCode: 'A', courseName: 'a', credit: 5, scoreValue: 100 })],
      [
        { id: 'a1', ruleCode: 'ACA_COMPETITION', category: 'ACADEMIC', grantedScore: 3 },
        { id: 'a2', ruleCode: 'ACA_CERT', category: 'ACADEMIC', grantedScore: 1 },
        { id: 'a3', ruleCode: 'ACA_RESEARCH', category: 'ACADEMIC', grantedScore: 2 },
      ],
      DEFAULT_ENGINE_OPTIONS,
    );
    // 75 + 2 + 6 = 83 → 封顶 75
    expect(r.academicTotal).toBe(75);
    expect(r.flags).toContain('CAPOUT_ACADEMIC_75');
  });

  test('排名：total→品德→学业→文体→学号', () => {
    const rows = [
      { studentId: 'a', studentNo: '20250102', classId: 'c1', totalScore: 90, moralTotal: 12, academicTotal: 70, sportsTotal: 8 },
      { studentId: 'b', studentNo: '20250101', classId: 'c1', totalScore: 90, moralTotal: 12, academicTotal: 70, sportsTotal: 8 },
      { studentId: 'c', studentNo: '20250103', classId: 'c2', totalScore: 90, moralTotal: 11, academicTotal: 71, sportsTotal: 8 },
      { studentId: 'd', studentNo: '20250104', classId: 'c2', totalScore: 85, moralTotal: 12, academicTotal: 70, sportsTotal: 3 },
    ];
    const ranks = rankAll(rows as any);
    // dense rank：a/b 四维完全同分 → 并列第1；c 第2；d 第3
    expect(ranks.get('b')!.rankGrade).toBe(1);
    expect(ranks.get('a')!.rankGrade).toBe(1);
    expect(ranks.get('c')!.rankGrade).toBe(2);
    expect(ranks.get('d')!.rankGrade).toBe(3);
    expect(ranks.get('c')!.rankClass).toBe(1);
    expect(ranks.get('b')!.rankClass).toBe(1);
    expect(ranks.get('a')!.rankClass).toBe(1);
    expect(ranks.get('d')!.rankClass).toBe(2);
  });
});
