import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HomeAssistantConnect } from './HomeAssistantConnect';
import type { SecretsStore } from '../utils/secrets';
import { haConfigKey, type HaStatus, type HomeAssistantConfig } from '../../shared/home-assistant';
import { HOME_ASSISTANT_SINCE } from '../../shared/version';

const IMPORTS_OFF = { notifyOnImport: false, notifyOnImportTrades: true };
const SAVED: HomeAssistantConfig = { enabled: true, mode: 'notify', url: 'http://ha.local:8123', token: 'tok', service: 'mobile_app_phone', titlePrefix: '', linkBase: '', ...IMPORTS_OFF };
const EMPTY: HomeAssistantConfig = { enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '', ...IMPORTS_OFF };

function storeWith(config: HomeAssistantConfig, status: HaStatus | null = null, companion: string | null = HOME_ASSISTANT_SINCE) {
  return {
    getHomeAssistantConfig: vi.fn(async () => config),
    setHomeAssistantConfig: vi.fn(async () => {}),
    getHomeAssistantStatus: vi.fn(async () => status),
    queueHomeAssistantTest: vi.fn(async (): Promise<'off' | 'queued'> => 'queued'),
    getCompanionVersion: vi.fn(async () => companion),
  };
}
const renderCard = (store: ReturnType<typeof storeWith>) =>
  render(<HomeAssistantConnect store={store as unknown as SecretsStore} isOpen={() => true} toggleCard={vi.fn()} />);

describe('HomeAssistantConnect', () => {
  it('saves a complete config, and only then offers a test', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Home Assistant URL'), { target: { value: SAVED.url } });
    fireEvent.change(screen.getByLabelText('Notify service'), { target: { value: SAVED.service } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Long-lived access token'), { target: { value: SAVED.token } });
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith(SAVED));
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(store.queueHomeAssistantTest).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent(/within 5 minutes/);
  });

  it('takes only a webhook URL in webhook mode', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    fireEvent.change(await screen.findByLabelText('Send through'), { target: { value: 'webhook' } });
    expect(screen.queryByLabelText('Long-lived access token')).toBeNull();
    expect(screen.queryByLabelText('Notify service')).toBeNull();
    const url = 'http://ha.local:8123/api/webhook/abc123';
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith({ ...EMPTY, mode: 'webhook', url }));
    expect(await screen.findByRole('button', { name: 'Send a test' })).toBeEnabled();
  });

  it('saves the title prefix and tap-link address, and refuses an address without a scheme', async () => {
    const store = storeWith(SAVED);
    renderCard(store);
    fireEvent.change(await screen.findByLabelText('Title prefix'), { target: { value: '[Wealth]' } });
    const address = screen.getByLabelText('Wealthfolio address for tap links');
    fireEvent.change(address, { target: { value: 'wf.example.com' } });
    expect(screen.getByText(/starting with http/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(address, { target: { value: 'https://wf.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith(
      { ...SAVED, titlePrefix: '[Wealth]', linkBase: 'https://wf.example.com' },
    ));
  });

  it('shows the companion\'s last failure until a later delivery', async () => {
    renderCard(storeWith(SAVED, {
      lastOkAt: '2027-03-14T10:00:00.000Z',
      lastError: 'Home Assistant answered 401 (check the access token)', lastErrorAt: '2027-03-15T10:00:00.000Z',
    }));
    expect(await screen.findByText(/Last delivery failed .*check the access token/)).toBeInTheDocument();
    expect(screen.getByText('Delivery failing')).toBeInTheDocument();
  });

  it('refuses a Home Assistant URL that is not http(s), or that carries a password', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    const url = await screen.findByLabelText('Home Assistant URL');
    fireEvent.change(screen.getByLabelText('Notify service'), { target: { value: SAVED.service } });
    fireEvent.change(screen.getByLabelText('Long-lived access token'), { target: { value: SAVED.token } });
    fireEvent.change(url, { target: { value: 'homeassistant.local:8123' } });
    expect(screen.getByText(/starting with http/)).toBeInTheDocument();
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(url, { target: { value: 'http://me:secret@ha.local:8123' } });
    expect(screen.getByText(/user name and password/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(url, { target: { value: SAVED.url } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saves the import-notice switches, off by default', async () => {
    const store = storeWith(SAVED);
    renderCard(store);
    const imports = await screen.findByLabelText(/each sync that imports new transactions/);
    expect(imports).not.toBeChecked();
    expect(screen.queryByLabelText('Include investment buys and sells')).toBeNull();
    fireEvent.click(imports);
    fireEvent.click(screen.getByLabelText('Include investment buys and sells'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith(
      { ...SAVED, notifyOnImport: true, notifyOnImportTrades: false },
    ));
  });

  it('says so when the test was not queued because Home Assistant is off', async () => {
    const store = storeWith(SAVED);
    store.queueHomeAssistantTest.mockResolvedValueOnce('off');
    renderCard(store);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/off in the saved settings/);
  });

  it('says when a test could not be queued', async () => {
    const store = storeWith(SAVED);
    store.queueHomeAssistantTest.mockRejectedValueOnce(new Error('storage locked'));
    renderCard(store);
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Couldn't queue the test: storage locked/);
  });

  it('shows delivery as paused after a failure retrying cannot fix', async () => {
    renderCard(storeWith(SAVED, {
      lastError: 'Home Assistant answered 401 (check the access token)', lastErrorAt: '2027-03-15T10:00:00.000Z',
      failedFor: haConfigKey(SAVED), parked: true,
    }));
    expect(await screen.findByText('Delivery paused')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is sent until you change the address, access token or notify service, or send a test/)).toBeInTheDocument();
  });

  it('shows a pass that delivered some alerts and then failed as failing, not Connected', async () => {
    const at = '2027-03-15T10:00:00.000Z';
    renderCard(storeWith(SAVED, {
      lastOkAt: at, lastError: 'Home Assistant answered 401 (check the access token)', lastErrorAt: at,
      failedFor: haConfigKey(SAVED), parked: true,
    }));
    expect(await screen.findByText('Delivery paused')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).toBeNull();
  });

  it('says a config saved since the last failure is not checked yet', async () => {
    renderCard(storeWith(SAVED, {
      lastError: 'Could not reach Home Assistant (host not found)', lastErrorAt: '2027-03-15T10:00:00.000Z',
      failedFor: haConfigKey({ ...SAVED, url: 'http://typo.local:8123' }), failures: 6, retryAt: '2027-03-15T14:00:00.000Z',
    }));
    expect(await screen.findByText('Changed, not checked yet')).toBeInTheDocument();
    expect(screen.getByText('Changed since the last failure. Send a test to check it.')).toBeInTheDocument();
    expect(screen.queryByText(/host not found/)).toBeNull();
  });

  it('says when alerts were dropped unsent', async () => {
    renderCard(storeWith(SAVED, {
      lastOkAt: new Date().toISOString(), dropped: 3, droppedAt: new Date().toISOString(),
    }));
    expect(await screen.findByText(/3 alerts waited over a week/)).toBeInTheDocument();
  });

  it('asks for a newer companion instead of fields it would never read', async () => {
    renderCard(storeWith(EMPTY, null, '1.73.0'));
    expect(await screen.findByText(new RegExp(`Needs the companion container ${HOME_ASSISTANT_SINCE} or newer`))).toBeInTheDocument();
    expect(screen.queryByLabelText('Home Assistant URL')).toBeNull();
  });
});
