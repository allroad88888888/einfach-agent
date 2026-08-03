import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { UnknownTimelineItem } from './index'

describe('UnknownTimelineItem', () => {
  it('renders an unknown kind as text without interpreting it as HTML', () => {
    const { container } = render(
      <UnknownTimelineItem item={{ id: 'unknown-1', kind: '<img src=x onerror=alert(1)>' }} />,
    )

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})
