import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ReceiptReaderConnect } from './ReceiptReaderConnect';
import type { SecretsStore } from '../utils/secrets';
import { DEFAULT_RECEIPT_MODEL, type ReceiptHostStatus, type ReceiptReaderConfig } from '../../shared/receipt-flow';

const SAVED: ReceiptReaderConfig = { enabled: true, url: 'http://192.168.1.20:11434', model: DEFAULT_RECEIPT_MODEL };
const EMPTY: ReceiptReaderConfig = { enabled: true, url: '', model: DEFAULT_RECEIPT_MODEL };

function storeWith(config: ReceiptReaderConfig, host: ReceiptHostStatus | null = null, companion: string | null = '1.72.0') {
  return {
    getReceiptReaderConfig: vi.fn(async () => config),
    setReceiptReaderConfig: vi.fn(async () => {}),
    getReceiptHostStatus: vi.fn(async () => host),
    getCompanionVersion: vi.fn(async () => companion),
  };
}
const renderCard = (store: ReturnType<typeof storeWith>) =>
  render(<ReceiptReaderConnect store={store as unknown as SecretsStore} isOpen={() => true} toggleCard={vi.fn()} />);

describe('ReceiptReaderConnect', () => {
  it('saves the host with the default model', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Model host (Ollama)'), { target: { value: SAVED.url } });
    fireEvent.click(save);
    await waitFor(() => expect(store.setReceiptReaderConfig).toHaveBeenCalledWith(SAVED));
    expect(await screen.findByRole('status')).toHaveTextContent(/within 5 minutes/);
  });

  it("shows the companion's last look at the host", async () => {
    renderCard(storeWith(SAVED, { checkedAt: new Date().toISOString(), error: `${DEFAULT_RECEIPT_MODEL} isn't installed on the model host` }));
    expect(await screen.findByText(/Problem \(checked just now\): .*isn't installed/)).toBeInTheDocument();
    expect(screen.getByText('Problem')).toBeInTheDocument();
  });

  it('asks for a newer companion instead of fields it would never read', async () => {
    renderCard(storeWith(EMPTY, null, '1.70.0'));
    expect(await screen.findByText(/Needs the companion container 1.72.0 or newer/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Model host (Ollama)')).toBeNull();
  });
});
