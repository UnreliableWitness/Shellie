import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blankPrDraft } from '../../shared/prDraft';
import { PrDescriptionField } from './PrDescriptionField';

afterEach(cleanup);

describe('PrDescriptionField', () => {
  it('says a description that could not be written as an alert, with what to do', () => {
    render(
      <PrDescriptionField
        draft={blankPrDraft('failed', 'the agent gave no text')}
        onChange={() => undefined}
        onRewrite={() => undefined}
        onSkip={() => undefined}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Not written: the agent gave no text. Type one here, or leave it empty for the commit list only.',
    );
  });
});
