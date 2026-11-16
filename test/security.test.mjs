import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeUrl, redactSensitive, isSafeMediaUrl, safeFilename, classifyMaterialPayload } from "../src/lib/security.js";

test("references strip login credentials, signed media query parameters and fragment secrets", () => {
  const sanitized = sanitizeUrl("https://login:password@cdn.example.org/file.mp3?version=2&token=secret&X-Amz-Credential=credential&X-Amz-Signature=signed#access_token=fragment");
  assert.equal(sanitized, "https://cdn.example.org/file.mp3?version=2");
  assert.equal(sanitizeUrl("/lesson/42?apiKey=secret&lang=ru", "https://school.example.org"), "https://school.example.org/lesson/42?lang=ru");
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("wss://proxy.example.org/websocket?authToken=secret&sessionToken=secret&code=secret&csrf=secret&version=1"), "wss://proxy.example.org/websocket?version=1");
});

test("nested credentials and account records are removed while author answer keys survive", () => {
  const input = {
    title: "Lesson",
    headers: { Authorization: "secret-auth" },
    data: {
      accessToken: "secret-token",
      studentResults: [{ email: "student@example.org", score: 3 }],
      userProfile: { firstName: "Private" },
      payment: { balance: 10 },
      blocks: [{ type: "test", answer_key: { correct: "A" }, teacher_note: "Say hello", image: "https://cdn.example.org/a.png?signature=secret-signature" }],
    },
  };
  const sanitized = redactSensitive(input);
  const serialized = JSON.stringify(sanitized);
  for (const secret of ["secret-auth", "secret-token", "student@example.org", "Private", "secret-signature"]) assert.ok(!serialized.includes(secret));
  assert.equal(sanitized.data.blocks[0].answer_key.correct, "A");
  assert.equal(sanitized.data.blocks[0].teacher_note, "Say hello");
  assert.equal(input.data.accessToken, "secret-token", "sanitization must not mutate the live source response");
});

test("text and HTML references cannot retain query tokens or bearer strings", () => {
  const sanitized = redactSensitive('<img src="https://cdn.example.org/a.jpg?token=secret-token"> Bearer secret-auth; password=secret-password');
  assert.ok(!sanitized.includes("secret-token"));
  assert.ok(!sanitized.includes("secret-auth"));
  assert.ok(!sanitized.includes("secret-password"));
});

test("relative JSON URLs and HTML media attributes scrub signatures without changing exercise prose", () => {
  assert.equal(redactSensitive("/media/a.jpg?sig=plain-secret&width=200"), "/media/a.jpg?width=200");
  assert.equal(redactSensitive("//cdn.example.org/a.jpg?signature=protocol-secret&version=2"), "//cdn.example.org/a.jpg?version=2");
  assert.equal(redactSensitive("/media/a.mp3?policy=policy-secret&token=token-secret"), "/media/a.mp3");
  const html = '<img src="/media/a.jpg?width=200&amp;sig=image-secret"><a href=//cdn.example.org/b.pdf?policy=pdf-secret>Open</a><video poster=\'/media/c.jpg?signature=poster-secret\'></video><audio src="//cdn.example.org/d.mp3?token=audio-secret"></audio>';
  const sanitized = redactSensitive(html);
  for (const secret of ["image-secret", "pdf-secret", "poster-secret", "audio-secret"]) assert.ok(!sanitized.includes(secret), secret);
  assert.ok(sanitized.includes('src="/media/a.jpg?width=200"'));
  assert.ok(sanitized.includes("href=//cdn.example.org/b.pdf"));
  assert.equal(redactSensitive("Choose a policy = fair. The mathematical expression is sig = x. A signature belongs at the end."), "Choose a policy = fair. The mathematical expression is sig = x. A signature belongs at the end.");
  assert.equal(redactSensitive("<p>signature=John; policy=accept; sig=4</p>"), "<p>signature=John; policy=accept; sig=4</p>");
});

test("download candidates reject local/private destinations and URL credentials", () => {
  assert.equal(isSafeMediaUrl("https://cdn.example.org/sound.mp3?token=one-use"), true);
  for (const url of [
    "http://cdn.example.org/sound.mp3", "file:///etc/passwd", "data:video/mp4;base64,AA==", "https://localhost/a", "https://school.local/a",
    "https://127.0.0.1/a", "https://2130706433/a", "https://0x7f000001/a", "https://10.0.0.1/a", "https://172.18.0.1/a", "https://192.168.0.1/a",
    "https://169.254.169.254/a", "https://100.64.0.1/a", "https://[::1]/a", "https://login:password@cdn.example.org/a", "https://cdn.example.org:8443/a", "https://localhost./a", "https://school.local./a",
  ]) assert.equal(isSafeMediaUrl(url), false, url);
});

test("filenames cannot escape media directory or choose executable HTML extensions", () => {
  assert.equal(safeFilename("../../course/test.mp3?token=secret"), "test.mp3");
  assert.equal(safeFilename("https://cdn.example.org/%2e%2e%2fimage.png?token=secret"), "image.png");
  assert.equal(safeFilename("CON"), "asset.bin");
  assert.equal(safeFilename("", "../../backup.json"), "backup.json");
  assert.equal(safeFilename("page.html"), "page.bin");
  assert.ok(safeFilename(`${"long".repeat(80)}.pdf`).endsWith(".pdf"));
  assert.equal(safeFilename(`${"long".repeat(80)}.pdf`).length, 160);
});

test("material classifier accepts lesson structure and excludes private API paths", () => {
  assert.equal(classifyMaterialPayload({ url: "https://school.example.org/lesson-editor/book/1/lesson/2/section/3" }), true);
  assert.equal(classifyMaterialPayload({ url: "https://proxy.example.org/rpc", data: { result: { sections: [{ blocks: [] }] } } }), true);
  assert.equal(classifyMaterialPayload({ url: "https://school.example.org/api/students", data: { lessons: [] } }), false);
  assert.equal(classifyMaterialPayload({ url: "https://school.example.org/api/account", data: { materials: [] } }), false);
  assert.equal(classifyMaterialPayload({ url: "https://analytics.example.org/ping", data: { token: "secret" } }), false);
});

test("material classifier accepts only confirmed successful RPC reads and retains empty exercise sections", () => {
  const url = "wss://proxy.progressme.ru/websocket";
  const response = { Class: "GetExerciseWsController", Method: "LoadExercisesInMaterial", IsSuccess: true, Value: {
    Items: [{ Id: 41, Type: 10, QuestionWithCodingTexts: [{ Text: "A [cat] sleeps." }] }],
  } };
  assert.equal(classifyMaterialPayload({ url, data: response }), true);
  assert.equal(classifyMaterialPayload({ url, data: { ...response, Method: "LoadExercises" } }), true);
  assert.equal(classifyMaterialPayload({ url, data: { ...response, Value: { Items: [] } } }), true);
  assert.equal(classifyMaterialPayload({ url, data: { Class: "LessonWsController", Method: "GetLessonWithId", IsSuccess: true, Value: { Sections: [] } } }), true);
  assert.equal(classifyMaterialPayload({ url, data: { Class: "LessonWsController", Method: "GetLessonPreview", IsSuccess: true, Value: { Sections: [], Book: { Id: 1 } } } }), true);
  for (const data of [
    { ...response, IsSuccess: false },
    { ...response, IsSuccess: undefined },
    { ...response, Method: "SaveExercise", Value: { Exercises: [] } },
    { ...response, Class: "UserWsController", Value: { Lessons: [] } },
    { ...response, Value: { Items: [{ Id: 41, Type: 999 }] } },
    { ...response, Value: { Items: [{ Id: 0, Type: 10 }] } },
    { ...response, Value: { Items: "serialized account data" } },
  ]) assert.equal(classifyMaterialPayload({ url: "https://progressme.ru/api/exercises", data }), false);
  assert.equal(classifyMaterialPayload({ url: "https://progressme.ru/api/students", data: response }), false);
});

test("persisted exercise envelopes keep only author definitions, including nested correct answers", () => {
  const response = { Class: "GetExerciseWsController", Method: "LoadExercises", IsSuccess: true, RequestId: "request-only", Value: {
    Items: [{ Id: 12, Type: 5, Name: "Quiz", Test: { Questions: [{ Answers: ["A", "B"], QuestionAnswers: ["true", "false"] }] },
      Answers: [{ Answer: "private-attempt" }], EssaysPupils: ["private-essay"], CurrentPupilId: 5,
      AnswerVersion1: [], AnswersTeacher: [], Grades: [4], Statistics: {},
    }], Pupils: [{ Name: "private-person" }],
  } };
  const clean = redactSensitive(response);
  assert.deepEqual(clean.Value.Items, [{ Id: 12, Type: 5, Name: "Quiz", Test: { Questions: [{ Answers: ["A", "B"], QuestionAnswers: ["true", "false"] }] } }]);
  assert.doesNotMatch(JSON.stringify(clean), /private-|request-only|Pupil|AnswerVersion1|AnswersTeacher|Grades|Statistics/);
  assert.equal(response.Value.Items[0].Answers[0].Answer, "private-attempt", "the source response must remain untouched");
  const mixed = redactSensitive([response, { Class: "UserWsController", Method: "GetAccount", IsSuccess: true, Value: { Lessons: [], Name: "private-person" } }]);
  assert.doesNotMatch(JSON.stringify(mixed), /private-|UserWsController|GetAccount/);
});

test("serialized JsonData and ImagesJson are redacted as JSON without changing their string format", () => {
  const source = {
    JsonData: JSON.stringify({ imageUrl: "/files/a.png?token=url-secret&width=200", nested: { password: "password-secret", accessToken: "token-secret", credentials: { opaque: "credential-secret" } },
      Questions: [{ Answers: ["cat", "dog"], QuestionAnswers: ["true", "false"] }],
    }),
    ImagesJson: JSON.stringify([{ url: "/files/b.png?signature=image-secret", title: "A cat" }]),
  };
  const sanitized = redactSensitive(source);
  const json = JSON.parse(sanitized.JsonData);
  assert.equal(typeof sanitized.JsonData, "string");
  assert.equal(typeof sanitized.ImagesJson, "string");
  assert.equal(json.imageUrl, "/files/a.png?width=200");
  assert.deepEqual(json.Questions[0], { Answers: ["cat", "dog"], QuestionAnswers: ["true", "false"] });
  assert.equal(JSON.parse(sanitized.ImagesJson)[0].url, "/files/b.png");
  assert.doesNotMatch(JSON.stringify(sanitized), /url-secret|password-secret|token-secret|image-secret|credential-secret/);
  for (const value of ["[draft text]", "42", '"author text"', "null"]) {
    assert.equal(redactSensitive({ JsonData: value }).JsonData, value);
  }
  assert.ok(source.JsonData.includes("password-secret"));
});

test("authored scoring config survives persistence without runtime scores or learner history", () => {
  const config = {
    TotalPoints: 5, TotalCountAnswers: 2, MaxPoints: 10,
    TestAnswers: [{ AnswerId: 11, Points: 5, PupilId: 123, Answer: "private-runtime-answer", IsTrueAnswer: true }],
    Points: [{ CountAnswersFalse: 0, Point: 10, Pupil: { Name: "private-person" }, ActualPoints: 8 }],
    Scores: ["private-scores"], PupilAnswers: ["private-history"], Grade: "private-grade",
  };
  const statistics = { ScoringType: 3, ConfigurationJson: JSON.stringify(config), Score: "private-score", ActualPoints: 8,
    Pupils: [{ Name: "private-person" }], AnswerVersion1: ["private-attempt"] };
  const response = { Class: "GetExerciseWsController", Method: "LoadExercises", IsSuccess: true, Value: { Items: [
    { Id: 12, Type: 5, Statistics: statistics, JsonData: JSON.stringify({ Statistics: statistics }) },
  ] } };
  const expected = { TotalPoints: 5, TotalCountAnswers: 2, MaxPoints: 10,
    TestAnswers: [{ AnswerId: 11, Points: 5 }], Points: [{ CountAnswersFalse: 0, Point: 10 }] };
  const clean = redactSensitive(response);
  const item = clean.Value.Items[0];
  for (const value of [item.Statistics, JSON.parse(item.JsonData).Statistics]) {
    assert.deepEqual(Object.keys(value).sort(), ["ConfigurationJson", "ScoringType"]);
    assert.equal(value.ScoringType, 3);
    assert.equal(typeof value.ConfigurationJson, "string");
    assert.deepEqual(JSON.parse(value.ConfigurationJson), expected);
  }
  assert.doesNotMatch(JSON.stringify(clean), /private-|Pupil|ActualPoints|AnswerVersion|IsTrueAnswer/);
  assert.ok(statistics.ConfigurationJson.includes("private-runtime-answer"), "source data is never mutated");
});

test("malformed or private scoring config cannot hide personal values in an allowed authored field", () => {
  const privateData = { PupilName: "private-person", Answer: "private-answer" };
  const values = [
    "private-malformed-json", JSON.stringify([privateData]), JSON.stringify({ TotalPoints: privateData }),
    JSON.stringify({ TestAnswers: [{ AnswerId: privateData, Points: "private-points" }] }),
    JSON.stringify({ Points: { Pupil: privateData } }),
    JSON.stringify({ TestAnswers: Array.from({ length: 4001 }, () => ({ AnswerId: 1, Points: 3, Pupil: privateData })) }),
  ];
  for (const ConfigurationJson of values) {
    const clean = redactSensitive({ Statistics: { ScoringType: 0, ConfigurationJson, Score: privateData } });
    assert.doesNotMatch(JSON.stringify(clean), /private-|Pupil/);
    assert.match(JSON.stringify(clean), /unsupported scoring definition/, "unknown scoring remains detectable by the importer");
  }
  assert.deepEqual(redactSensitive({ Statistics: { Score: privateData } }), {});
});

test("empty authored scoring defaults remain inactive without preserving runtime scores", () => {
  for (const ConfigurationJson of [null, "", " \n\t "]) {
    const source = { Statistics: { ScoringType: 0, ConfigurationJson, Score: "private-score", PupilAnswers: ["private-history"] } };
    assert.deepEqual(redactSensitive(source), { Statistics: { ScoringType: 0, ConfigurationJson } });
    assert.equal(source.Statistics.Score, "private-score");
  }
  for (const ConfigurationJson of ["invalid nonempty", "null", "[]"]) {
    assert.match(redactSensitive({ Statistics: { ConfigurationJson } }).Statistics.ConfigurationJson, /unsupported scoring definition/);
  }
});

test('book inventory persistence validates and projects only source group identity and lesson counts', () => {
  const url = 'wss://proxy.progressme.ru/websocket';
  for (const Class of ['CourseWsController', 'SharingMaterialWsController']) {
    const source = { Class, Method: 'GetBookCourses', IsSuccess: true, ProjectName: 'Books', SessionId: 'private-session', Value: [
      { Id: 12, Name: 'Group', CountLesson: 2, BookId: 99, Owner: 'private-owner', Students: ['private-person'] },
      { Id: 13, Name: 'Empty', CountLesson: 0, Profile: { Name: 'private-profile' } },
    ] };
    assert.equal(classifyMaterialPayload({ url, data: source }), true);
    const clean = redactSensitive(source);
    // Preserve source book identity so the importer can reject a foreign inventory.
    assert.deepEqual(clean.Value, [{ Id: 12, Name: 'Group', CountLesson: 2, BookId: 99 }, { Id: 13, Name: 'Empty', CountLesson: 0 }]);
    assert.doesNotMatch(JSON.stringify(clean), /private-|SessionId|Students|Owner|Profile/);
    for (const invalid of [
      { ...source, Value: [{ Id: 0, Name: 'Group', CountLesson: 0 }] },
      { ...source, Value: [{ Id: 12, Name: {}, CountLesson: 0 }] },
      { ...source, Value: [{ Id: 12, Name: 'Group', CountLesson: '2' }] },
      { ...source, Value: [{ Id: 12, Name: 'Group', CountLesson: -1 }] },
      { ...source, Value: [{ Id: 12, Name: 'Group', CountLesson: 10001 }] },
      { ...source, Value: [{ Id: 12, Name: 'Group', CountLesson: 0 }, { Id: 12, Name: 'Other', CountLesson: 0 }] },
      { ...source, Value: [{ Id: 12, Name: 'Group', CountLesson: 0, BookId: 0 }] },
      { ...source, Value: Array.from({ length: 1001 }, (_, index) => ({ Id: index + 1, Name: 'Group', CountLesson: 0 })) },
      { ...source, Class: 'UserWsController' }, { ...source, Method: 'SetBookCourses' },
      { ...source, ProjectName: 'Profiles' }, { ...source, IsSuccess: false },
    ]) {
      assert.equal(classifyMaterialPayload({ url, data: invalid }), false);
      assert.equal(redactSensitive(invalid), '[REDACTED]');
    }
  }
});

test('absolute HTML URL entities cannot retain signatures while visible exercise prose is preserved', () => {
  const prose = '<p>Choose a policy = fair. The mathematical expression is sig = x.</p>';
  const html = prose + '<img src="https://cdn.example.org/a.png?width=200&amp;sig=private-signature&amp;policy=private-policy&#38;Key-Pair-Id=private-key&#x26;version=2">';
  assert.equal(redactSensitive(html), prose + '<img src="https://cdn.example.org/a.png?width=200&amp;version=2">');
  const response = { Class: 'GetExerciseWsController', Method: 'LoadExercises', IsSuccess: true,
    Value: { Items: [{ Id: 1, Type: 28, Text: { Text: html }, JsonData: JSON.stringify({ Text: { Text: html } }) }] } };
  const result = redactSensitive(response).Value.Items[0];
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.equal(result.Text.Text, prose + '<img src="https://cdn.example.org/a.png?width=200&amp;version=2">');
  assert.equal(JSON.parse(result.JsonData).Text.Text, result.Text.Text);
});

test('persisted twenty-question timed tests preserve author timing, answer keys and points independently', () => {
  const questions = Array.from({ length: 20 }, (_, index) => ({
    Id: 700 + index, Question: `Question ${index + 1}`, Points: index % 3 + 1,
    Answers: [`Correct ${index + 1}`, `Alternative ${index + 1}`], QuestionAnswers: ['true', ''],
  }));
  const authored = { Id: 41, Type: 5, UsedNewConstructor: true,
    Test: { IsEnabledTimer: true, TimerDuration: 20, IsEnabledPoints: true, Questions: questions },
    Statistics: { ScoringType: 3, ConfigurationJson: JSON.stringify({ TotalCountAnswers: 20,
      TestAnswers: questions.map(question => ({ AnswerId: question.Id, Points: question.Points })) }) },
  };
  const response = { Class: 'GetExerciseWsController', Method: 'LoadExercisesInMaterial', IsSuccess: true,
    ConnectionId: 'private-connection', Value: { Items: [{ ...authored,
      CurrentPupilId: 9, Answers: [{ Answer: 'private-attempt' }], Grades: [4],
      Timers: [{ PupilId: 9, DateStart: 'private-runtime-date' }],
      AnswerVersion1: [{ Answer: 'private-history' }],
    }], Pupils: [{ Name: 'private-pupil' }] } };
  assert.equal(classifyMaterialPayload({ url: 'wss://proxy.progressme.ru/websocket', data: response }), true);
  const sanitized = redactSensitive(response);
  assert.deepEqual(sanitized.Value.Items, [authored]);
  assert.equal(sanitized.Value.Items[0].Test.Questions.length, 20);
  assert.doesNotMatch(JSON.stringify(sanitized), /private-|CurrentPupilId|Pupils|Grades|Timers|AnswerVersion1/);
  assert.equal(response.Value.Items[0].Answers[0].Answer, 'private-attempt');
});
