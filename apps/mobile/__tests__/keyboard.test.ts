import { keyboardPadding } from '../src/keyboard';

describe('keyboardPadding (Android edge-to-edge IME inset)', () => {
  const ev = (height: number) => ({ endCoordinates: { height, screenX: 0, screenY: 0, width: 0 } });
  it('pads by the reported keyboard height (already net of the nav bar)', () => {
    expect(keyboardPadding(ev(812.4))).toBe(812);
  });
  it('never pads for hidden, negative or malformed events', () => {
    expect(keyboardPadding(null)).toBe(0);
    expect(keyboardPadding(ev(0))).toBe(0);
    expect(keyboardPadding(ev(-48))).toBe(0);
    expect(keyboardPadding(ev(Number.NaN))).toBe(0);
    expect(keyboardPadding({} as never)).toBe(0);
  });
});
