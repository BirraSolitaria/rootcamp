import type { Task, UserAnswer } from '@rootcamp/content-schema';

type InteractiveTask = Exclude<Task, { type: 'terminal_practice' }>;

/** A user answer that checkAnswer accepts for `task`. */
export function rightFor(task: InteractiveTask): UserAnswer {
  switch (task.type) {
    case 'single_choice':
      return { type: 'single_choice', selectedIndex: task.correctIndex };
    case 'true_false':
      return { type: 'true_false', value: task.answer };
    case 'assemble':
      return { type: 'assemble', tokens: [...task.answer] };
    case 'fill_blank':
      return { type: 'fill_blank', text: task.acceptedAnswers[0] as string };
    case 'match_pairs':
      return { type: 'match_pairs', pairs: task.pairs.map((p) => ({ ...p })) };
    case 'order_steps':
      return { type: 'order_steps', order: [...task.steps] };
  }
}

/** A user answer that checkAnswer rejects for `task`. */
export function wrongFor(task: InteractiveTask): UserAnswer {
  switch (task.type) {
    case 'single_choice':
      return { type: 'single_choice', selectedIndex: (task.correctIndex + 1) % task.options.length };
    case 'true_false':
      return { type: 'true_false', value: !task.answer };
    case 'assemble':
      return { type: 'assemble', tokens: [...task.answer].reverse() };
    case 'fill_blank':
      return { type: 'fill_blank', text: '%%wrong%%' };
    case 'match_pairs':
      return { type: 'match_pairs', pairs: [] };
    case 'order_steps':
      return { type: 'order_steps', order: [...task.steps].reverse() };
  }
}
