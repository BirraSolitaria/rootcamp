import { brokenText } from '../api/messages';
import { Mascot } from './Mascot';
import styles from './ErrorScreen.module.css';

/** §9 «Внутренняя ошибка»: «Что-то сломалось (код reqId)» with the sad mascot. */
export function ErrorScreen({ reqId, onRetry }: { reqId?: string; onRetry?: () => void }) {
  return (
    <div className={styles.screen} role="alert">
      <Mascot state="sad" size={96} />
      <h1 className="t-title">{brokenText(reqId)}</h1>
      <p className="t-body">Мы уже знаем. Попробуй обновить страницу.</p>
      <button type="button" className="btn" onClick={onRetry ?? (() => window.location.reload())}>
        Обновить
      </button>
    </div>
  );
}
