/**
 * Browser half of the FiNess brand. Occupies the substrate's brand slots with the FiNess mark and
 * name, sets the tab title and swaps the favicon. Hand-written in the lazy-CJS shape the substrate's
 * client module table loads (`window.__ModuleLoader__.load`), so there is no build step; React comes
 * from the shell's frozen module table. The tab title is otherwise build-time, so the first paint can
 * still flash the substrate's name before `apply` runs (accepted, documented in the README).
 */
window.__ModuleLoader__.load({
	id: '@finess/client-ui-brand',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const React = require('react')
		const h = React.createElement

		/** Display name, also the tab title. */
		const BRAND_NAME = 'FiNess'
		/** Slots occupied (declared by ui-sidebar and ui-conversation). */
		const SLOTS = {
			sidebarMark: 'sidebar.brand.mark',
			sidebarName: 'sidebar.brand.name',
			heroMark: 'conversation.hero.brand.mark',
		}
		/** Substrate names in the tab title that this plugin rewrites. */
		const SUBSTRATE_TITLE = /DSH Local Build|DeepSeek Harness|\bDSH\b/g
		/** Square accent that reads on light and dark backgrounds; the F is white on it. */
		const MARK_FILL = '#3b5bdb'
		const MARK_PATH = 'M7.5 6.5h9v2.4h-6.3v2.3h5v2.4h-5v4H7.5z'

		/**
		 * The FiNess mark: a rounded square with an F monogram. Accessible, fixed colours.
		 * @param {{size?: number, className?: string}} props - slot owner props.
		 * @returns {object} the svg element.
		 */
		function Mark(props) {
			const size = typeof props?.size === 'number' ? props.size : 24
			return h('svg', {
				xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', width: size, height: size,
				role: 'img', 'aria-label': BRAND_NAME, className: props?.className, style: { flex: 'none' },
			}, h('rect', { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: MARK_FILL }), h('path', { d: MARK_PATH, fill: '#fff' }))
		}

		/** The name beside the sidebar mark; inherits the surrounding text colour. */
		function Name() {
			return h('span', { style: { fontWeight: 600, letterSpacing: '0.01em', color: 'inherit' } }, BRAND_NAME)
		}

		/** The mark as a data URI, for the favicon `<link>`. */
		const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="${MARK_FILL}"/><path d="${MARK_PATH}" fill="#fff"/></svg>`)

		/**
		 * Brand the document: title now, kept while the substrate rewrites it, and the favicon.
		 * @param {Document} [doc] - the document (a parameter for tests).
		 * @returns {() => void} undo, restoring the previous title and favicon.
		 */
		function brandDocument(doc) {
			doc = doc ?? (typeof document === 'undefined' ? undefined : document)
			if (doc === undefined) return () => {}
			const before = doc.title
			const fix = () => {
				const next = doc.title.replace(SUBSTRATE_TITLE, BRAND_NAME)
				const want = next === '' ? BRAND_NAME : next
				if (want !== doc.title) doc.title = want
			}
			fix()
			let observer
			const titleEl = doc.querySelector?.('title')
			if (titleEl !== null && titleEl !== undefined && typeof MutationObserver === 'function') {
				observer = new MutationObserver(fix)
				observer.observe(titleEl, { childList: true, characterData: true, subtree: true })
			}
			const links = [...(doc.querySelectorAll?.('link[rel~="icon"]') ?? [])]
			const saved = links.map(l => [l, l.getAttribute('href'), l.getAttribute('type')])
			let own
			if (links.length === 0 && doc.head !== null && doc.head !== undefined) {
				own = doc.createElement('link')
				own.setAttribute('rel', 'icon')
				doc.head.appendChild(own)
				links.push(own)
			}
			for (const l of links) { l.setAttribute('href', FAVICON); l.setAttribute('type', 'image/svg+xml') }
			return () => {
				observer?.disconnect()
				doc.title = before
				for (const [l, href, type] of saved) {
					if (href === null) l.removeAttribute('href'); else l.setAttribute('href', href)
					if (type === null) l.removeAttribute('type'); else l.setAttribute('type', type)
				}
				own?.remove()
			}
		}

		/** Required service: the UI slot registry. */
		const inject = ['slots']
		/** Below the official brand's 0, so FiNess shadows it instead of clashing with it. */
		const PRIORITY = -10

		/**
		 * Occupy the three brand slots as one declaration-aware set (nested injects wait for every
		 * declarer, so activation order does not matter and HMR leaves no partial brand), and brand the page.
		 * @param {object} ctx - client root context.
		 */
		function apply(ctx) {
			const slots = ctx.slots
			ctx.effect(() => brandDocument(), 'finess-brand: document')
			slots.inject(SLOTS.sidebarMark, () =>
				slots.inject(SLOTS.sidebarName, () =>
					slots.inject(SLOTS.heroMark, function* () {
						// The shipped (official) build registers its mark and name in these single slots at
						// priority 0; a second entry at the same priority throws, and the lowest renders.
						yield slots.register({ name: SLOTS.sidebarMark, priority: PRIORITY }, Mark)
						yield slots.register({ name: SLOTS.sidebarName, priority: PRIORITY }, Name)
						yield slots.register({ name: SLOTS.heroMark, priority: PRIORITY }, Mark)
					})))
		}

		exports.BRAND_NAME = BRAND_NAME
		exports.SLOTS = SLOTS
		exports.Mark = Mark
		exports.Name = Name
		exports.FAVICON = FAVICON
		exports.brandDocument = brandDocument
		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
