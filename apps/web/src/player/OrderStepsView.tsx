import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { OrderStepsTask } from '@rootcamp/content-schema';
import { shuffleSteps } from '@rootcamp/logic';
import { useLayoutEffect, useRef, useState } from 'react';
import { NATIVE_ENTER } from './keys';
import styles from './OrderStepsView.module.css';
import { HEADING_ATTR, type TaskViewProps } from './types';
import views from './views.module.css';

const idOf = (i: number) => `step-${i}`;
const indexOf = (id: UniqueIdentifier) => Number(String(id).slice(5));

/** Initial order as indices into `steps` (shuffleSteps works on texts; texts may repeat). */
function initialOrder(steps: readonly string[], rng: () => number): number[] {
  const used = new Set<number>();
  return shuffleSteps([...steps], rng).map((text) => {
    const i = steps.findIndex((s, j) => s === text && !used.has(j));
    used.add(i);
    return i;
  });
}

/**
 * Vertical list sorted by drag-and-drop (@dnd-kit/sortable: mouse, touch, keyboard via the
 * handle) or the ↑/↓ buttons. The answer is formed by the first move: the initial order is
 * never the correct one (shuffleSteps), so «Проверить» stays disabled until then.
 */
export function OrderStepsView({ task, locked, rng, onChange }: TaskViewProps<OrderStepsTask>) {
  const steps = task.steps;
  const [order, setOrder] = useState(() => initialOrder(steps, rng));
  const [touched, setTouched] = useState(false);
  const [status, setStatus] = useState('');
  const listRef = useRef<HTMLOListElement>(null);
  const pendingFocus = useRef<{ step: number; dir: 'up' | 'down' } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Moving a node in the DOM drops its focus: give it back to the ↑/↓ button just pressed
  // (or its twin when the step reached the edge).
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const item = listRef.current?.querySelector(`[data-index="${p.step}"]`);
    const want = item?.querySelector<HTMLButtonElement>(`[data-dir="${p.dir}"]`);
    const other = item?.querySelector<HTMLButtonElement>(
      `[data-dir="${p.dir === 'up' ? 'down' : 'up'}"]`,
    );
    (want && !want.disabled ? want : other)?.focus();
  }, [order]);

  const apply = (next: number[]) => {
    setOrder(next);
    setTouched(true);
    onChange({ type: 'order_steps', order: next.map((i) => steps[i]!) });
  };
  const move = (from: number, to: number, dir?: 'up' | 'down') => {
    if (locked || to < 0 || to >= order.length || from === to) return;
    const step = order[from]!;
    if (dir) pendingFocus.current = { step, dir };
    apply(arrayMove(order, from, to));
    setStatus(`«${steps[step]}» — шаг ${to + 1} из ${order.length}`);
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    move(order.indexOf(indexOf(active.id)), order.indexOf(indexOf(over.id)));
  };

  const label = (id: UniqueIdentifier) => `«${steps[indexOf(id)]}»`;
  const position = (id: UniqueIdentifier | undefined) =>
    id === undefined ? 0 : order.indexOf(indexOf(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Шаг ${label(active.id)} взят, позиция ${position(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over ? `Шаг ${label(active.id)} над позицией ${position(over.id)}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? `Шаг ${label(active.id)} поставлен на позицию ${position(over.id)}.`
        : `Шаг ${label(active.id)} отпущен.`,
    onDragCancel: ({ active }) => `Перемещение шага ${label(active.id)} отменено.`,
  };

  return (
    <div className={views.root}>
      <h2 className={views.question} tabIndex={-1} {...HEADING_ATTR}>
        {task.prompt}
      </h2>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'Чтобы взять шаг, нажми пробел или Enter. Стрелки вверх и вниз двигают его, пробел или Enter — отпустить, Escape — отменить.',
          },
        }}
      >
        <SortableContext
          items={order.map(idOf)}
          strategy={verticalListSortingStrategy}
          disabled={locked}
        >
          <ol className={styles.list} aria-label="Порядок шагов" ref={listRef}>
            {order.map((step, pos) => (
              <SortableStep
                key={step}
                step={step}
                text={steps[step]!}
                position={pos}
                count={order.length}
                locked={locked}
                onMove={move}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <p className="visually-hidden" role="status">
        {touched ? status : ''}
      </p>
    </div>
  );
}

interface SortableStepProps {
  step: number;
  text: string;
  position: number;
  count: number;
  locked: boolean;
  onMove(from: number, to: number, dir: 'up' | 'down'): void;
}

function SortableStep({ step, text, position, count, locked, onMove }: SortableStepProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: idOf(step), attributes: { roleDescription: 'перетаскиваемый шаг' } });
  return (
    <li
      ref={setNodeRef}
      className={[styles.item, isDragging ? styles.dragging : ''].join(' ')}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-step={text}
      data-index={step}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className={styles.handle}
        {...attributes}
        {...listeners}
        {...NATIVE_ENTER}
        aria-label={`Перетащить: ${text}`}
        disabled={locked}
      >
        <svg width="14" height="20" viewBox="0 0 14 20" aria-hidden="true" fill="currentColor">
          <circle cx="4" cy="4" r="1.6" />
          <circle cx="10" cy="4" r="1.6" />
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="4" cy="16" r="1.6" />
          <circle cx="10" cy="16" r="1.6" />
        </svg>
      </button>
      <span className={styles.num} aria-hidden="true">
        {position + 1}
      </span>
      <span className={styles.text}>{text}</span>
      <span className={styles.arrows}>
        <button
          type="button"
          className={styles.arrow}
          data-dir="up"
          {...NATIVE_ENTER}
          aria-label={`Выше: ${text}`}
          disabled={locked || position === 0}
          onClick={() => onMove(position, position - 1, 'up')}
        >
          <span aria-hidden="true">↑</span>
        </button>
        <button
          type="button"
          className={styles.arrow}
          data-dir="down"
          {...NATIVE_ENTER}
          aria-label={`Ниже: ${text}`}
          disabled={locked || position === count - 1}
          onClick={() => onMove(position, position + 1, 'down')}
        >
          <span aria-hidden="true">↓</span>
        </button>
      </span>
    </li>
  );
}
