import type { SummaryDto } from '@rootcamp/api-contract';
import { useNavigate } from 'react-router-dom';
import { Summary } from '../../player/Summary';

/** End of a session: XP, «без ошибок» / correct answers, daily goal, streak; «Продолжить» → `exitTo`. */
export function SummaryView({ summary, exitTo }: { summary: SummaryDto; exitTo: string }) {
  const navigate = useNavigate();
  return <Summary summary={summary} onContinue={() => navigate(exitTo)} />;
}
