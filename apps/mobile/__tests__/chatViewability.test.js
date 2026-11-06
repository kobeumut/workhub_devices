// Use the installed native FlatList algorithm, not a copy of its visibility predicate.
const ViewabilityHelper = require('@react-native/virtualized-lists/Lists/ViewabilityHelper').default;
const { chatReadViewability } = require('../../../packages/features/src/talkState');
jest.mock('@workhub-devices/core', () => require('../../../packages/core/src/talkSync'));

it('oversized messages and fully visible short rows qualify, offscreen rows do not', () => {
  const helper = new ViewabilityHelper(chatReadViewability);
  const props = { data: [0], getItemCount: () => 1 };
  const metrics = (offset, length) => ({ getCellMetrics: () => ({ index: 0, offset, length, isMounted: true }) });
  expect(helper.computeViewableItems(props, 0, 500, metrics(0, 1500))).toEqual([0]);
  expect(helper.computeViewableItems(props, 600, 500, metrics(0, 1500))).toEqual([0]);
  expect(helper.computeViewableItems(props, 0, 500, metrics(100, 50))).toEqual([0]);
  expect(helper.computeViewableItems(props, 0, 500, metrics(501, 50))).toEqual([]);
  expect(chatReadViewability.minimumViewTime).toBe(300);
  helper.dispose();
});
