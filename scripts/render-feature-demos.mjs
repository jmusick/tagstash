import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const workDirectory = process.env.TAGSTASH_DEMO_WORK_DIR
if (!workDirectory) throw new Error('Set TAGSTASH_DEMO_WORK_DIR to the project working directory containing recordings.json')
const demoPath = name => resolve(workDirectory, name).replaceAll('\\', '/')
const ffmpeg = process.env.FFMPEG_PATH || demoPath('tools/node_modules/ffmpeg-static/ffmpeg.exe')
const recordings = JSON.parse(await readFile(demoPath('recordings.json'), 'utf8'))
const outputWidth = 1120
const outputHeight = 704
const appHeight = 630
await mkdir(demoPath('render'), { recursive: true })
await mkdir('public/feature-demos', { recursive: true })
const number = value => Number(value).toFixed(4)

// Smooth editorial pointer movement between the real recorded click targets.
// This is an overlay, not an OS cursor track. App frames preserve actual timing.
function pointerExpression(events, axis, scale, duration) {
  const origin = axis === 'x' ? 760 : 520
  const points = [{ time: 0, [axis]: origin }, ...events, { time: duration - 0.15, [axis]: origin }]
  let expression = number(origin * scale)
  for (let i = 1; i < points.length; i++) {
    const end = points[i].time
    const begin = Math.max(points[i - 1].time + 0.35, end - 0.65)
    if (begin >= end) continue
    const from = points[i - 1][axis] * scale
    const to = points[i][axis] * scale
    const phase = `clip((t-${number(begin)})/${number(end - begin)},0,1)`
    const tween = `${number(from)}+(${number(to - from)})*((${phase})*(${phase})*(3-2*(${phase})))`
    expression = `if(lt(t,${number(begin)}),${expression},if(lt(t,${number(end)}),${tween},${number(to)}))`
  }
  return expression
}

for (const recording of recordings) {
  if (!recording.events.length || recording.frames.length < 24) throw new Error(`Incomplete recording: ${recording.name}`)
  const viewport = recording.viewport || { width: 1280, height: 720 }
  if (viewport.width !== 1280 || viewport.height !== 720) throw new Error('Record at the default 1280 by 720 viewport')
  const scale = outputWidth / viewport.width
  const stem = demoPath(`render/${recording.name}`)
  const concat = ['ffconcat version 1.0']
  for (let i = 0; i < recording.frames.length; i++) {
    const frame = recording.frames[i]
    const nextTime = recording.frames[i + 1]?.time ?? recording.duration
    concat.push(`file '${frame.path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`, `duration ${number(Math.max(0.001, nextTime - frame.time))}`)
  }
  await writeFile(`${stem}.ffconcat`, concat.join('\n'))
  const captions = []
  for (const [index, caption] of recording.captions.entries()) {
    const file = `${stem}-${index}.txt`
    await writeFile(file, caption.text)
    const end = recording.captions[index + 1]?.time ?? recording.duration
    const font = process.platform === 'win32' ? "fontfile='C\\:/Windows/Fonts/segoeui.ttf'" : 'font=Sans'
    const captionPath = file.replaceAll(':', '\\:').replaceAll("'", "'\\''")
    captions.push(`drawtext=${font}:textfile='${captionPath}':fontcolor=white:fontsize=22:x=24:y=654:enable='gte(t,${number(caption.time)})*lt(t,${number(end)})'`)
  }
  const x = pointerExpression(recording.events, 'x', scale, recording.duration)
  const y = pointerExpression(recording.events, 'y', scale, recording.duration)
  const clicks = recording.events.map(event => `between(t,${number(event.time)},${number(event.time + 0.35)})`).join('+')
  const filters = [
    `[0:v]fps=24,scale=${outputWidth}:${appHeight},setsar=1,pad=${outputWidth}:${outputHeight}:0:0:color=0x1b1a20,${captions.join(',')}[app]`,
    '[1:v]scale=32:40,format=rgba[cursor]',
    '[2:v]scale=42:42,format=rgba[click]',
    `[app][click]overlay=x='(${x})-21':y='(${y})-21':enable='${clicks}':shortest=1[highlighted]`,
    `[highlighted][cursor]overlay=x='(${x})-3':y='(${y})-3':shortest=1,fade=t=in:d=0.12,fade=t=out:st=${number(recording.duration - 0.12)}:d=0.12,format=yuv420p[out]`,
  ]
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-safe', '0', '-f', 'concat', '-i', `${stem}.ffconcat`, '-loop', '1', '-i', 'scripts/assets/demo-cursor.png', '-loop', '1', '-i', 'scripts/assets/demo-click.png', '-filter_complex_threads', '1', '-filter_complex', filters.join(';'), '-map', '[out]', '-t', number(recording.duration), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `public/feature-demos/${recording.name}.mp4`], { stdio: 'pipe' })
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', `public/feature-demos/${recording.name}.mp4`, '-ss', '0.25', '-frames:v', '1', '-q:v', '3', `public/feature-demos/${recording.name}.jpg`], { stdio: 'pipe' })
  console.log(`Rendered ${recording.name}: ${recording.frames.length} captured frames, ${recording.duration.toFixed(1)}s`)
}
