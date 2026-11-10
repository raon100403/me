const backgroundSlider = document.querySelector('#background-color');
const themeColor = document.querySelector('meta[name="theme-color"]');
const colorStops = [
  [0, 0, 0],
  [255, 0, 0],
  [255, 255, 0],
  [0, 255, 0],
  [0, 255, 255],
  [0, 0, 255],
  [255, 0, 255],
  [255, 255, 255],
];

function updateBackground() {
  const position = Number(backgroundSlider.value) / 100;
  const index = Math.min(Math.floor(position), colorStops.length - 2);
  const fraction = position - index;
  const rgb = colorStops[index].map((channel, i) =>
    Math.round(channel + (colorStops[index + 1][i] - channel) * fraction),
  );
  const color = `#${rgb.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
  const linear = rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const foreground = luminance > 0.179 ? '#111111' : '#ffffff';
  const root = document.documentElement;

  root.style.setProperty('--page-background', color);
  root.style.setProperty('--page-foreground', foreground);
  root.style.setProperty('--icon-color', foreground);
  root.style.colorScheme = luminance > 0.179 ? 'light' : 'dark';
  themeColor.setAttribute('content', color);
  backgroundSlider.setAttribute('aria-valuetext', color);
}

backgroundSlider.addEventListener('input', updateBackground);
