import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiInfo } from './api-info';

describe('card API information', () => {
  it('shows the actual endpoint and function for owner metadata', () => {
    render(<ApiInfo label="Owners" description="Current Owner role assignments, not the original creator."
      endpoint="/v1/admin/connections/{connectionId}/roleAssignments" />);
    fireEvent.click(screen.getByRole('button', { name: 'API information for Owners' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('GET https://api.fabric.microsoft.com/v1/admin/connections/{connectionId}/roleAssignments');
    expect(screen.getByRole('tooltip')).toHaveTextContent('CollectConnectionInventory notebook');
    expect(screen.getByRole('tooltip')).toHaveTextContent('read-only connector');
  });
  function renderInfo() {
    render(<ApiInfo label="Gateway footprint" description="Distinct gatewayId values; no separate gateway API." />);
    return screen.getByRole('button', { name: 'API information for Gateway footprint' });
  }

  it('shows the endpoint on hover and hides it on mouse leave', () => {
    const button = renderInfo();
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('GET https://api.fabric.microsoft.com/v1/admin/connections');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Distinct gatewayId');
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('pins on click and dismisses on a second click or outside pointer press', () => {
    const button = renderInfo();
    fireEvent.click(button);
    fireEvent.mouseLeave(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tooltip')).toBeVisible();
    fireEvent.click(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(button);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('supports keyboard focus, Escape, and blur dismissal', () => {
    const button = renderInfo();
    fireEvent.focus(button);
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.click(button);
    fireEvent.blur(button, { relatedTarget: document.body });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
