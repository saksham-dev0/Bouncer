export const NEEDS_CODE_Q = {
  type: 'noul',
  instructions: 'Does doing `task` require reading source files in the repository?',
};

export function skimQuestion(candidate) {
  return {
    type: 'noul',
    instructions: {
      file: { path: candidate.path, symbols: candidate.symbols },
      question: 'Would a developer doing `task` likely need to open `file`?',
    },
  };
}

export function closeLookQuestion(path, detail) {
  return {
    type: 'score',
    instructions: {
      file: { path, ...detail },
      question: 'How relevant is `file` to doing `task`?',
    },
    criteria: [
      'Unrelated: a different feature or area than the task',
      'Tangential: same general area, but not needed for the task',
      'Supporting: useful context (callers, types, config, tests of the target)',
      'Core: the task directly changes or depends on this file',
    ],
  };
}

export function dirQuestion(dir, examples) {
  return {
    type: 'noul',
    instructions: {
      directory: { path: dir, example_files: examples },
      question: 'Is any file in `directory` likely needed by a developer doing `task`?',
    },
  };
}

export function followupRequest(previousTask, prompt) {
  return {
    state: { previous_task: previousTask, prompt },
    questions: {
      new_task: {
        type: 'noul',
        instructions: 'Does `prompt` start a different task from `previous_task`, rather than continuing, approving or refining it?',
      },
      adds_scope: {
        type: 'noul',
        instructions: 'Does `prompt` mention files, features or areas of the code that `previous_task` does not already cover?',
      },
      needs_code: {
        type: 'noul',
        instructions: 'Does doing what `prompt` asks, in the context of `previous_task`, require reading source files in the repository?',
      },
    },
  };
}
