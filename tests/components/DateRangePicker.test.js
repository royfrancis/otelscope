import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DateRangePicker from '../../docs/.vitepress/components/DateRangePicker.vue'

const at = (...args) => new Date(...args).getTime()
const MIN = at(2026, 9, 20, 14) // 20 Oct 2026, mid-afternoon: the whole day can still be picked
const MAX = at(2026, 9, 28, 9)

let wrapper
let anchor
async function open(props = {}) {
  anchor = document.createElement('div') // the picker closes on a click outside its parent, so give it one
  document.body.append(anchor)
  wrapper = mount(DateRangePicker, { props: { min: MIN, max: MAX, from: at(2026, 9, 22), to: at(2026, 9, 24), ...props }, attachTo: anchor })
  await flushPromises() // it moves the focus onto a day once it is on screen
  return wrapper
}
afterEach(() => {
  wrapper?.unmount()
  anchor?.remove()
})

const day = (key) => wrapper.find(`.viz-cal-day[data-day="${key}"]`)
const title = () => wrapper.find('.viz-cal-title').text()
const summary = () => wrapper.find('.viz-cal-summary').text()
const apply = () => wrapper.find('.viz-cal-apply')
const marked = () => wrapper.findAll('.viz-cal-day[aria-pressed="true"]').map((b) => b.attributes('data-day'))
const between = () => wrapper.findAll('.viz-cal-day.in-range').map((b) => b.attributes('data-day'))
const focusedDay = () => document.activeElement?.getAttribute('data-day')

describe('DateRangePicker', () => {
  it('shows the month of the end of the range, with weeks that start on Monday', async () => {
    await open()
    expect(title()).toBe('October 2026')
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    const days = wrapper.findAll('.viz-cal-day')
    expect(days).toHaveLength(35) // 28 Sep ... 1 Nov: five whole weeks
    expect(days[0].attributes('data-day')).toBe('2026-09-28')
    expect(days[0].classes()).toContain('is-out') // a day of the neighboring month is dimmed
    expect(day('2026-10-25').text()).toBe('25') // the 25-hour day is one cell, like any other
  })

  it('opens with the focus on a day, so the keyboard works at once', async () => {
    await open()
    expect(focusedDay()).toBe('2026-10-24')
    expect(day('2026-10-24').attributes('tabindex')).toBe('0')
    expect(day('2026-10-23').attributes('tabindex')).toBe('-1') // one stop in the tab order, not 35
  })

  it('cannot pick days before the first datapoint\'s day or after the last one\'s', async () => {
    await open()
    expect(day('2026-10-19').attributes('disabled')).toBeDefined()
    expect(day('2026-10-20').attributes('disabled')).toBeUndefined() // the first day, though the data starts in the afternoon
    expect(day('2026-10-28').attributes('disabled')).toBeUndefined()
    expect(day('2026-10-29').attributes('disabled')).toBeDefined()
    await day('2026-10-19').trigger('click')
    await day('2026-10-29').trigger('click')
    expect(summary()).toBe('22 Oct 2026 – 24 Oct 2026') // nothing happened: the range it was given is still there
  })

  it('picks a first day, then a last day, and Apply gives the window from the start of one to the end of the other', async () => {
    await open()
    expect(apply().attributes('disabled')).toBeUndefined() // the range it was given
    await day('2026-10-21').trigger('click')
    expect(summary()).toBe('From 21 Oct 2026: pick the last day')
    await day('2026-10-26').trigger('click')
    expect(summary()).toBe('21 Oct 2026 – 26 Oct 2026')
    expect(marked()).toEqual(['2026-10-21', '2026-10-26'])
    expect(between()).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])
    await apply().trigger('click')
    expect(wrapper.emitted('apply')).toEqual([[{ startMs: at(2026, 9, 21), endMs: at(2026, 9, 27) - 1 }]])
  })

  it('takes the two days in either order', async () => {
    await open()
    await day('2026-10-26').trigger('click')
    await day('2026-10-21').trigger('click')
    expect(summary()).toBe('21 Oct 2026 – 26 Oct 2026')
  })

  it('a third click starts a new range, and one day alone is a range of one day', async () => {
    await open()
    await day('2026-10-21').trigger('click')
    await day('2026-10-23').trigger('click')
    await day('2026-10-27').trigger('click') // starts again
    expect(summary()).toBe('From 27 Oct 2026: pick the last day')
    await apply().trigger('click') // Apply with just the first day
    expect(wrapper.emitted('apply')[0][0]).toEqual({ startMs: at(2026, 9, 27), endMs: at(2026, 9, 28) - 1 })
  })

  it('previews the range while the last day is not chosen yet', async () => {
    await open({ from: null, to: null })
    expect(apply().attributes('disabled')).toBeDefined() // nothing chosen: nothing to apply
    await day('2026-10-21').trigger('click')
    await day('2026-10-25').trigger('mouseenter')
    expect(between()).toEqual(['2026-10-22', '2026-10-23', '2026-10-24'])
  })

  it('goes to the month before and after, but not past the data', async () => {
    await open({ min: at(2026, 8, 15), max: at(2026, 10, 5), to: at(2026, 9, 24) })
    const [prev, next] = wrapper.findAll('.viz-cal-nav')
    await next.trigger('click')
    expect(title()).toBe('November 2026')
    expect(next.attributes('disabled')).toBeDefined() // the data ends on 5 Nov
    await prev.trigger('click')
    await prev.trigger('click')
    expect(title()).toBe('September 2026')
    expect(prev.attributes('disabled')).toBeDefined() // and starts in September
  })

  it('moves the focus with the arrow keys, over to the next month when it has to', async () => {
    await open({ max: at(2026, 10, 10) })
    const press = async (key) => { await wrapper.find(`.viz-cal-day[data-day="${focusedDay()}"]`).trigger('keydown', { key }); await wrapper.vm.$nextTick() }
    await press('ArrowRight')
    expect(focusedDay()).toBe('2026-10-25')
    await press('ArrowDown')
    expect(focusedDay()).toBe('2026-11-01')
    expect(title()).toBe('November 2026') // the focus left October, so the calendar followed it
    await press('ArrowUp')
    expect(focusedDay()).toBe('2026-10-25')
    expect(title()).toBe('October 2026')
    await press('Home')
    expect(focusedDay()).toBe('2026-10-20') // the Monday is the 19th, before the data, so it stops at the first day
    expect(day('2026-10-20').attributes('tabindex')).toBe('0')
  })

  it('keeps the focus inside the days that can be picked', async () => {
    await open({ to: at(2026, 9, 28) })
    const press = async (key) => { await wrapper.find(`.viz-cal-day[data-day="${focusedDay()}"]`).trigger('keydown', { key }); await wrapper.vm.$nextTick() }
    await press('ArrowRight') // 29 Oct is after the data
    expect(focusedDay()).toBe('2026-10-28')
    await press('PageDown')
    expect(focusedDay()).toBe('2026-10-28')
  })

  it('leaves other keys alone, so Tab and Enter do their usual things', async () => {
    await open()
    const before = focusedDay()
    await day(before).trigger('keydown', { key: 'Tab' })
    await day(before).trigger('keydown', { key: 'a' })
    expect(focusedDay()).toBe(before)
  })

  it('closes with Escape, with Cancel, and with a click outside, but not with a click inside', async () => {
    await open()
    await wrapper.find('.viz-cal').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.findAll('.viz-cal-foot .viz-btn')[0].trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.find('.viz-cal-title').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(2) // inside: stays open
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(3)
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('stops listening for outside clicks once it is gone', async () => {
    await open()
    const emitted = wrapper.emitted()
    wrapper.unmount()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(emitted.close).toBeUndefined()
    wrapper = null
  })

  it('names each day in full for a screen reader, and marks the ends of the range', async () => {
    await open({ from: at(2026, 9, 21), to: at(2026, 9, 23) })
    expect(day('2026-10-21').attributes('aria-label')).toMatch(/Wednesday,? 21 October 2026/)
    expect(marked()).toEqual(['2026-10-21', '2026-10-23'])
    expect(day('2026-10-21').classes()).toContain('is-from')
    expect(day('2026-10-23').classes()).toContain('is-to')
    expect(wrapper.find('.viz-cal').attributes('role')).toBe('dialog')
  })
})
