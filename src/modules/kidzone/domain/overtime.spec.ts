import { calculateOvertime, elapsedMinutes, sessionProgress } from './overtime';

const CHECK_IN = new Date('2026-09-22T10:00:00.000Z');
const after = (minutes: number) => new Date(CHECK_IN.getTime() + minutes * 60_000);

// The seeded "2 Hour Indoor" plan: 120 minutes, 10 minutes grace, then 30
// minute blocks at BDT 50 each.
const TWO_HOUR = {
  sessionMinutes: 120,
  gracePeriodMinutes: 10,
  overtimeBlockMinutes: 30,
  overtimeRatePerBlock: 5000,
};

describe('elapsedMinutes', () => {
  it('counts whole minutes and never goes negative', () => {
    expect(elapsedMinutes(CHECK_IN, after(90))).toBe(90);
    expect(elapsedMinutes(CHECK_IN, after(0))).toBe(0);
    expect(elapsedMinutes(after(10), CHECK_IN)).toBe(0);
  });

  it('truncates a partial minute', () => {
    expect(elapsedMinutes(CHECK_IN, new Date(CHECK_IN.getTime() + 119_000))).toBe(1);
  });
});

describe('calculateOvertime', () => {
  it('charges nothing when the session is not exceeded', () => {
    expect(calculateOvertime(CHECK_IN, after(120), TWO_HOUR)).toEqual({
      elapsedMinutes: 120,
      overtimeMinutes: 0,
      blocks: 0,
      overtimeCharge: 0,
    });
  });

  it('charges nothing inside the grace period', () => {
    expect(calculateOvertime(CHECK_IN, after(129), TWO_HOUR).overtimeCharge).toBe(0);
    expect(calculateOvertime(CHECK_IN, after(130), TWO_HOUR).overtimeCharge).toBe(0);
  });

  it('charges a whole block from the first minute past the grace period', () => {
    const result = calculateOvertime(CHECK_IN, after(131), TWO_HOUR);
    expect(result).toEqual({ elapsedMinutes: 131, overtimeMinutes: 1, blocks: 1, overtimeCharge: 5000 });
  });

  it('bills a started block as a full block', () => {
    expect(calculateOvertime(CHECK_IN, after(160), TWO_HOUR).blocks).toBe(1); // 30 minutes over
    expect(calculateOvertime(CHECK_IN, after(161), TWO_HOUR).blocks).toBe(2); // 31 minutes over
    expect(calculateOvertime(CHECK_IN, after(190), TWO_HOUR).blocks).toBe(2); // 60 minutes over
    expect(calculateOvertime(CHECK_IN, after(191), TWO_HOUR).blocks).toBe(3);
  });

  it('multiplies blocks by the rate in poisha', () => {
    expect(calculateOvertime(CHECK_IN, after(250), TWO_HOUR)).toMatchObject({
      overtimeMinutes: 120,
      blocks: 4,
      overtimeCharge: 20000,
    });
  });

  it('never charges an open-ended visit such as a membership', () => {
    const membership = { sessionMinutes: null, gracePeriodMinutes: 10, overtimeBlockMinutes: 30, overtimeRatePerBlock: 5000 };
    expect(calculateOvertime(CHECK_IN, after(600), membership)).toEqual({
      elapsedMinutes: 600,
      overtimeMinutes: 0,
      blocks: 0,
      overtimeCharge: 0,
    });
  });

  it('records the minutes but charges nothing when the plan has no overtime pricing', () => {
    const unpriced = { sessionMinutes: 120, gracePeriodMinutes: 10, overtimeBlockMinutes: null, overtimeRatePerBlock: null };
    expect(calculateOvertime(CHECK_IN, after(200), unpriced)).toEqual({
      elapsedMinutes: 200,
      overtimeMinutes: 70,
      blocks: 0,
      overtimeCharge: 0,
    });
  });

  it('treats a zero grace period as no grace at all', () => {
    const noGrace = { ...TWO_HOUR, gracePeriodMinutes: 0 };
    expect(calculateOvertime(CHECK_IN, after(121), noGrace).overtimeCharge).toBe(5000);
    expect(calculateOvertime(CHECK_IN, after(120), noGrace).overtimeCharge).toBe(0);
  });
});

describe('sessionProgress', () => {
  it('reports time left while the session is running', () => {
    expect(sessionProgress(CHECK_IN, after(45), TWO_HOUR)).toEqual({
      elapsedMinutes: 45,
      remainingMinutes: 75,
      isOvertime: false,
      overtimeMinutes: 0,
      withinGrace: false,
    });
  });

  it('flags the grace period separately from real overtime', () => {
    expect(sessionProgress(CHECK_IN, after(125), TWO_HOUR)).toMatchObject({
      remainingMinutes: -5,
      isOvertime: false,
      withinGrace: true,
    });
    expect(sessionProgress(CHECK_IN, after(135), TWO_HOUR)).toMatchObject({
      remainingMinutes: -15,
      isOvertime: true,
      withinGrace: false,
    });
  });

  it('leaves remaining time undefined for an open-ended visit', () => {
    expect(sessionProgress(CHECK_IN, after(300), { sessionMinutes: null, gracePeriodMinutes: 10 })).toMatchObject({
      remainingMinutes: null,
      isOvertime: false,
    });
  });
});
