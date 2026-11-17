export const resumeBook = 'https://progressme.ru/cabinet/school/materials/book/71/content';
export const resumeSection = 'https://progressme.ru/lesson-editor/book/71/lesson/8/section/9';

export function savedResumeState() {
  const capturedAt = '2026-11-16T10:00:00.000Z';
  const key = '71/8/section/id/9';
  const definition = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
    ProjectName: 'Exercises', Value: { SectionId: 9, Count: 1, Items: [{ Id: 1, Type: 3, SectionId: 9, Name: 'Saved answer' }] } };
  return {
    id: 7, snapshots: [{ url: resumeBook, capturedAt }, { url: resumeSection, capturedAt }],
    captures: [{ kind: 'websocket', url: 'wss://proxy.progressme.ru/websocket', pageUrl: resumeSection,
      receivedAt: capturedAt, data: definition }], warnings: [], dropped: 0,
    collection: { status: 'interrupted', title: 'Saved book', rootUrl: resumeBook, startedAt: capturedAt,
      expected: [resumeBook, resumeSection], visited: [resumeBook, resumeSection], failed: [],
      items: [{ key: '71/book/lesson/id/8', title: 'Lesson', kind: 'lesson', lessonId: '8', status: 'running' },
        { key, title: 'Section', kind: 'section', lessonId: '8', url: resumeSection, status: 'visited' }],
      resume: { version: 1, rootUrl: resumeBook,
        book: [{ key: '71/book/lesson/id/8', title: 'Lesson', kind: 'lesson', sourceId: '8' }],
        lessons: [{ lessonId: '8', key: '71/book/lesson/id/8', sections: [{ key, title: 'Section', kind: 'section', sourceId: '9' }] }],
        confirmed: [{ url: resumeSection, lessonId: '8', key, capturedAt }] } },
  };
}
