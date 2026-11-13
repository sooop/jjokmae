<script module lang="ts">
  export type IconName =
    | 'chevron-left'
    | 'chevron-right'
    | 'chevron-down'
    | 'minus'
    | 'plus'
    | 'settings'
    | 'folder'
    | 'close'
    | 'rotate-cw'
    | 'trash'
    | 'copy'
    | 'extract'
    | 'send'
    | 'download'
    | 'undo'
    | 'redo'
    | 'arrow-up'
    | 'arrow-down'
    | 'more'
    | 'grip'
    | 'scissors'
    | 'merge'
    | 'check'
    | 'pointer'
    | 'highlighter'
    | 'square'
    | 'circle'
    | 'note'
    | 'text-box'
    | 'image'
    | 'form'
    | 'grid'
    | 'printer'
    | 'info'
    | 'alert'
    | 'upload';
</script>

<script lang="ts">
  let { name, size = 18 }: { name: IconName; size?: number } = $props();

  const paths: Record<IconName, string> = {
    'chevron-left': 'M15 18l-6-6 6-6',
    'chevron-right': 'M9 6l6 6-6 6',
    'chevron-down': 'M6 9l6 6 6-6',
    minus: 'M5 12h14',
    'rotate-cw': 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    extract: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M12 18v-6M9.5 14.5L12 12l2.5 2.5',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
    download: 'M12 3v12M7 10l5 5 5-5M4 21h16',
    undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
    redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
    'arrow-up': 'M12 19V5M5 12l7-7 7 7',
    'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
    scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
    merge: 'M5 4v6a4 4 0 0 0 4 4h10M5 20v-6M15 10l4 4-4 4',
    check: 'M5 12l5 5 9-10',
    pointer: 'M4 4l7 17 2.5-7.5L21 11z',
    highlighter: 'M9 11l-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4',
    square: 'M4 4h16v16H4z',
    circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    note: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    'text-box': 'M4 5h16v14H4zM8.5 9.5h7M12 9.5v6',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9.5h.01',
    form: 'M6 3h12v18H6zM9.5 8h5M9.5 12h5M9.5 16h3',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    printer: 'M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M6 14h12v7H6z',
    plus: 'M12 5v14M5 12h14',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5h.01',
    alert: 'M12 3.5L2.5 20h19zM12 10v4.5M12 17.5h.01',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    close: 'M6 6l12 12M18 6L6 18',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    settings:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name]} />
</svg>
