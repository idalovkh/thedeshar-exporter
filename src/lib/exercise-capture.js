import { isSourceUrl } from './state.js';
import { homeworkSectionId } from './homework-section.js';
import { responseTime } from './capture-response-time.js';

const definitions = new WeakMap();
const pagePath = value => {
  if (!isSourceUrl(value)) return '';
  const url = new URL(value);
  return /^\/lesson-editor\/book\/\d+\/lesson\/\d+(?:\/section\/(?:\d+|for-homework))?\/?$/.test(url.pathname)
    ? `${url.origin}${url.pathname}` : '';
};

function definitionSections(data) {
  if (!data || typeof data !== 'object') return [];
  if (definitions.has(data)) return definitions.get(data);
  const sections = [];
  let remaining = 100000;
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 24 || --remaining < 0) return;
    if (value.Class === 'GetExerciseWsController' && value.IsSuccess === true &&
        ['LoadExercises', 'LoadExercisesInMaterial'].includes(value.Method) && Array.isArray(value.Value?.Items)) {
      const section = value.Value.SectionId;
      const validSection = section => typeof section === 'number' && Number.isSafeInteger(section) && section > 0 ||
        typeof section === 'string' && /^(?:\d+|for-homework)$/.test(section);
      const itemSections = value.Value.Items.flatMap(item => {
        const section = item?.SectionId ?? item?.LessonSectionId;
        return validSection(section) ? [String(section)] : [];
      });
      const count = value.Value.Count;
      sections.push({ section: validSection(section) ? String(section) : null, itemSections,
        incomplete: Number.isSafeInteger(count) && count >= 0 && count > value.Value.Items.length });
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(data);
  definitions.set(data, sections);
  return sections;
}

/** Metadata only: raw definition bodies never cross the progress message. */
function selectedDefinition(captures, expectedUrl, metadata = captures) {
  const expected = pagePath(expectedUrl);
  if (!expected) return undefined;
  const sectionId = new URL(expected).pathname.match(/\/section\/([^/]+)/)?.[1];
  const homeworkId = sectionId === 'for-homework' ? homeworkSectionId(metadata, expected) : null;
  let selected;
  for (const capture of captures) {
    if (pagePath(capture.pageUrl) !== expected) continue;
    for (const definition of definitionSections(capture.data)) {
      const { section, itemSections } = definition;
      // Responses without IDs still use their observed page. When lesson
      // metadata resolves homework, reject delayed replies for another section.
      const expectedId = sectionId === 'for-homework' ? homeworkId : sectionId;
      const matches = !expectedId || (section === null || section === expectedId) &&
        (!itemSections.length || itemSections.includes(expectedId));
      if (!matches) continue;
      const receivedAt = responseTime(capture.receivedAt);
      // Match importer selection: a later timestamp wins; equal or invalid
      // timestamps fall back to the later branch/record in archive order.
      if (!selected || receivedAt === null || selected.receivedAt === null || receivedAt >= selected.receivedAt) {
        selected = { receivedAt, incomplete: definition.incomplete };
      }
    }
  }
  return selected;
}

const statusOf = selected => ({ received: !selected.incomplete, ...(selected.incomplete ? { reason: 'incomplete' } : {}) });

export function exerciseCaptureStatus(captures, expectedUrl) {
  const selected = selectedDefinition(captures, expectedUrl);
  return selected ? statusOf(selected) : { received: false };
}

/** Acknowledgement of this event, including duplicates already stored on disk. */
export function exerciseCaptureObservation(capture, expectedUrl, metadata) {
  const selected = selectedDefinition([capture], expectedUrl, metadata);
  return selected ? statusOf(selected) : undefined;
}

export const hasExerciseCapture = (captures, expectedUrl) => exerciseCaptureStatus(captures, expectedUrl).received;
