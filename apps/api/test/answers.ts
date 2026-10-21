// Right and wrong answers for any interactive task of a test course (lessons, review, drill).
import type { UserAnswer } from '@rootcamp/api-contract';
import type { Task } from '@rootcamp/content-schema';

export function rightAnswer(t: Task): UserAnswer {
  switch (t.type) {
    case 'single_choice':
      return { type: 'single_choice', selectedIndex: t.correctIndex };
    case 'true_false':
      return { type: 'true_false', value: t.answer };
    case 'assemble':
      return { type: 'assemble', tokens: t.answer };
    case 'fill_blank':
      return { type: 'fill_blank', text: t.acceptedAnswers[0]! };
    case 'match_pairs':
      return { type: 'match_pairs', pairs: t.pairs };
    case 'order_steps':
      return { type: 'order_steps', order: t.steps };
    case 'terminal_practice':
      throw new Error('terminal_practice has no answer');
  }
}

export function wrongAnswer(t: Task): UserAnswer {
  switch (t.type) {
    case 'single_choice':
      return { type: 'single_choice', selectedIndex: (t.correctIndex + 1) % t.options.length };
    case 'true_false':
      return { type: 'true_false', value: !t.answer };
    case 'assemble':
      return { type: 'assemble', tokens: ['nope'] };
    case 'fill_blank':
      return { type: 'fill_blank', text: 'nope' };
    case 'match_pairs':
      return { type: 'match_pairs', pairs: [] };
    case 'order_steps':
      return { type: 'order_steps', order: [...t.steps].reverse() };
    case 'terminal_practice':
      throw new Error('terminal_practice has no answer');
  }
}
