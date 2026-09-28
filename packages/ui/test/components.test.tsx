import { fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import {
  Badge,
  Button,
  Field,
  Input,
  KpiCard,
  Sparkline,
  ToastProvider,
  useToast,
  VelyricLogo,
} from '../src/index.js';

function ToastTrigger() {
  const { notify } = useToast();
  return (
    <Button
      onClick={() => {
        notify({ tone: 'error', title: 'Mentés sikertelen', description: 'Hivatkozás: abc' });
      }}
    >
      Ment
    </Button>
  );
}

describe('ui components', () => {
  it('renders accessible form fields, buttons and KPI cards', async () => {
    const { container } = render(
      <main>
        <VelyricLogo />
        <Field id="name" label="Név" error="Kötelező mező" required>
          <Input id="name" aria-invalid="true" aria-describedby="name-error" />
        </Field>
        <Button loading>Mentés</Button>
        <Badge tone="sky">Sales</Badge>
        <KpiCard
          label="Összes hívás"
          value="248"
          delta={12}
          deltaLabel="12% növekedés"
          trend={[3, 5, 4, 8, 6, 9]}
        />
        <Sparkline values={[1]} label="Trend" />
      </main>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Kötelező mező');
    expect(screen.getByRole('button', { name: 'Mentés' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByLabelText('12% növekedés').textContent).toContain('12%');
    const results = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });

  it('shows and dismisses toasts', () => {
    render(
      <ToastProvider closeLabel="Bezárás">
        <ToastTrigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ment' }));
    expect(screen.getByRole('alert').textContent).toContain('Mentés sikertelen');
    fireEvent.click(screen.getByRole('button', { name: 'Bezárás' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
