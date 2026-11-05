import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConnectionIdentity } from './connection-identity';

describe('connection identity capabilities', () => {
  it('shows a compact app-identity banner without unsupported identity controls', () => {
    render(<ConnectionIdentity />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('Snapshot visibility.')).toBeVisible();
    expect(screen.getByText(/The notebook collects/)).toHaveTextContent('execution identity');
    expect(screen.getByText(/The notebook collects/)).toHaveTextContent('tenant-wide inventory');
    expect(screen.getByText(/The notebook collects/)).toHaveTextContent('not necessarily yours');
    expect(screen.getByText(/The notebook collects/)).toHaveTextContent('restricted to authorized inventory readers');
    expect(screen.queryByText(/SPN/)).toBeNull();
  });
});
