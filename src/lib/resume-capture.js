import { appendCapture, createWorkspace } from './state.js';
import { exerciseCaptureObservation } from './exercise-capture.js';
import { confirmedResumePage } from './collection-resume.js';

/** A fresh access/readiness check must not overwrite a saved section's answers. */
export function observePreservedCapture(state, incoming, { resume = false } = {}) {
  if (!resume || !confirmedResumePage(state, incoming.pageUrl)) return null;
  // Reuse the independent storage admission checks on just this response; never
  // clone the retained book or append a newer definition to the archived data.
  const observation = appendCapture(createWorkspace(state.id), incoming);
  if (observation.dropped) return { state: { ...state, dropped: (state.dropped || 0) + observation.dropped,
    warnings: [...new Set([...(state.warnings || []), ...observation.warnings])] } };
  const accepted = observation.captures[0];
  return { state, exerciseCapture: accepted ? exerciseCaptureObservation(accepted, incoming.pageUrl, state.captures) : undefined };
}
