import { describe, expect, it } from 'vitest';
import { createStageTimer } from '../../../supabase/functions/_shared/serverTiming.pure';

describe('createStageTimer', () => {
  it('records each stage as the time since the previous mark, plus a total, as a Server-Timing header', () => {
    let t = 100;
    const timer = createStageTimer(() => t);
    t = 130; timer.mark('session');
    t = 180; timer.mark('load project');
    t = 185; timer.mark('respond');
    expect(timer.header()).toBe('session;dur=30.0, load_project;dur=50.0, respond;dur=5.0, total;dur=85.0');
  });
  it('is empty-safe and never throws on odd names', () => {
    const timer = createStageTimer(() => 0);
    expect(timer.header()).toBe('total;dur=0.0');
    timer.mark('a,b;c');
    expect(timer.header()).toBe('a_b_c;dur=0.0, total;dur=0.0');
  });
});
