import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { TemplatePageProps } from "../../document";
import type { TemplateColorRoles, TemplateFeatures, TemplateStyleContext, TemplateStyleSlots } from "../shared/types";
import { useMemo } from "react";
import { rgbaStringToHex } from "@reactive-resume/utils/color";
import { Page, StyleSheet, View } from "#react-pdf-renderer";
import { useRender } from "../../context";
import { getResumeSectionTitle } from "../../section-title";
import { useRenderedSectionIds, useResolvedNode } from "../../semantic/context";
import { semanticNodeKeys } from "../../semantic/node-keys";
import { CustomFieldContactItem, WebsiteContactItem } from "../shared/contact-item";
import { TemplateProvider, useTemplateStyle } from "../shared/context";
import { filterItems, filterSections } from "../shared/filtering";
import { getTemplateMetrics } from "../shared/metrics";
import {
	Heading,
	Link,
	SemanticContactListView,
	SemanticHeaderView,
	SemanticRegionView,
	Text,
} from "../shared/primitives";
import { createRtlStyleHelpers } from "../shared/rtl";
import { Section } from "../shared/sections";
import { composeStyles, headerNameLineHeight } from "../shared/styles";

/**
 * Tauros — single-column executive layout.
 *
 * - Uppercase navy name + headline, with a pipe-separated contact line.
 * - Entry sections (summary, experience, education, …) are full-width blocks: an uppercase navy
 *   heading with a 2px primary-colored top rule, content below.
 * - "Tag" sections — skills, languages, interests, and any custom section of those types
 *   (e.g. "Tech Stack") — render their items inline separated by a navy middle dot. The dot is
 *   bound to the preceding item with a non-breaking space, so a line wrap never starts with a
 *   leading dot.
 *
 * Tag sections have two title positions. The primary skills section keeps its title on TOP (it is
 * usually the longest list and reads better full-width); the secondary tag sections — languages,
 * interests, and custom skill/language/interest sections such as "Tech Stack" — use a compact
 * title-on-the-LEFT layout. Which sections render title-on-top is controlled by
 * TAG_TITLE_TOP_SECTIONS; this is a code-level switch because the template metadata has no
 * per-template option field yet (a user-facing toggle would require a schema + builder-UI change).
 *
 * React-PDF has no `::before` pseudo-elements, so the inline dot layout is rendered with a small
 * custom component (TaurosInlineSection) rather than the shared grid-based Section.
 */
const TAG_SECTION_TYPES = new Set(["skills", "languages", "interests"]);
const TAG_TITLE_TOP_SECTIONS = new Set(["skills"]);
const DOT_SEPARATOR = " · ";

// Applied to the first section on a continuation page so the top rule reads as a separator
// *between* sections rather than a stray line at the top of the page.
const NO_TOP_RULE: Style = { borderTopWidth: 0, paddingTop: 0 };

// Selects the executive experience header ("Company - Location" inline, bold role positions).
// Shared by every TemplateProvider in this template — the nested provider used for the
// continuation-page top-rule override must pass it too, or the first section on page 2 falls back
// to the default split-row header and renders the location right-aligned instead of inline.
const TAUROS_FEATURES: TemplateFeatures = { companyLocationInlineHeader: true };

type TaurosStyles = Omit<TemplateStyleSlots, "page"> & {
	page: Style;
	header: Style;
	headerName: Style;
	headerHeadline: Style;
	headerContactRow: Style;
	headerContactItem: Style;
	headerContactSeparator: Style;
	sections: Style;
	sectionCompact: Style;
	sectionHeadingCompact: Style;
	inlineList: Style;
	inlineListCompact: Style;
	inlineItem: Style;
	inlineSeparator: Style;
};

type TaurosTemplate = {
	colors: TemplateColorRoles;
	styles: TaurosStyles;
};

type TaurosHeaderProps = {
	styles: TaurosStyles;
};

type InlineSectionItem = { id: string; hidden: boolean };
type NamedItem = InlineSectionItem & { name: string };
type LanguageNamedItem = InlineSectionItem & { language: string };

type TaurosInlineSectionProps<T extends InlineSectionItem> = {
	sectionId: string;
	title: string;
	items: T[];
	getText: (item: T) => string;
	styles: TaurosStyles;
	hideTopRule: boolean;
};

export const TaurosPage = ({ page, pageSize, pageMinHeightStyle, showHeader, pageNumber }: TemplatePageProps) => {
	const data = useRender();
	const pageNodeKey = semanticNodeKeys.page(pageNumber);
	const { style: semanticPageStyle, size: semanticPageSize, ...semanticPageProps } = useResolvedNode(pageNodeKey);
	const { metadata } = data;
	const { colors, styles } = useTaurosTemplate();
	const metrics = getTemplateMetrics(metadata.page);
	const mainSections = useRenderedSectionIds(pageNodeKey, filterSections(page.main, data));
	const sidebarSections = useRenderedSectionIds(pageNodeKey, page.fullWidth ? [] : filterSections(page.sidebar, data));
	const sections = [...mainSections, ...sidebarSections];

	return (
		<Page
			{...semanticPageProps}
			size={semanticPageSize ?? pageSize}
			style={composeStyles(styles.page, pageMinHeightStyle, semanticPageStyle)}
		>
			<TemplateProvider pageNodeKey={pageNodeKey} styles={styles} colors={colors} features={TAUROS_FEATURES}>
				{showHeader && <Header styles={styles} />}

				<SemanticRegionView region="main" style={composeStyles(styles.sections, { rowGap: metrics.sectionGap })}>
					{sections.map((section, index) =>
						renderSection(section, data, styles, colors, !showHeader && index === 0, pageNodeKey),
					)}
				</SemanticRegionView>
			</TemplateProvider>
		</Page>
	);
};

const renderSection = (
	section: string,
	data: ReturnType<typeof useRender>,
	styles: TaurosStyles,
	colors: TemplateColorRoles,
	hideTopRule: boolean,
	pageNodeKey: string,
) => {
	// Experience keeps its executive header ("Company - Location" inline, bold role positions) but
	// renders through the shared Section so it participates in Semantic CSS. The layout comes from
	// the companyLocationInlineHeader template feature set on TemplateProvider below.

	// Standard tag sections render inline (dot-separated).
	if (section === "skills") {
		const { items, title } = data.sections.skills;
		return inlineTagSection(section, title, items, (item) => item.name, styles, hideTopRule);
	}
	if (section === "languages") {
		const { items, title } = data.sections.languages;
		return inlineTagSection(section, title, items, (item) => item.language, styles, hideTopRule);
	}
	if (section === "interests") {
		const { items, title } = data.sections.interests;
		return inlineTagSection(section, title, items, (item) => item.name, styles, hideTopRule);
	}

	// Custom sections of a tag type (e.g. a "Tech Stack" custom skills section) render inline too.
	const customSection = data.customSections.find((entry) => entry.id === section);
	if (customSection && TAG_SECTION_TYPES.has(customSection.type)) {
		if (customSection.type === "languages") {
			const items = customSection.items as unknown as LanguageNamedItem[];
			return inlineTagSection(section, customSection.title, items, (item) => item.language, styles, hideTopRule);
		}

		const items = customSection.items as unknown as NamedItem[];
		return inlineTagSection(section, customSection.title, items, (item) => item.name, styles, hideTopRule);
	}

	// Everything else uses the shared full-width block section. The shared Section reads its
	// container style from context, so to drop the top rule we override the `section` slot via a
	// nested provider.
	if (hideTopRule) {
		const noRuleStyles: TaurosStyles = { ...styles, section: composeStyles(styles.section as Style, NO_TOP_RULE) };
		return (
			<TemplateProvider
				key={section}
				pageNodeKey={pageNodeKey}
				styles={noRuleStyles}
				colors={colors}
				features={TAUROS_FEATURES}
			>
				<Section section={section} placement="main" />
			</TemplateProvider>
		);
	}
	return <Section key={section} section={section} placement="main" />;
};

const inlineTagSection = <T extends InlineSectionItem>(
	sectionId: string,
	title: string,
	items: T[],
	getText: (item: T) => string,
	styles: TaurosStyles,
	hideTopRule: boolean,
) => (
	<TaurosInlineSection
		key={sectionId}
		sectionId={sectionId}
		title={title}
		items={items}
		getText={getText}
		styles={styles}
		hideTopRule={hideTopRule}
	/>
);

function TaurosInlineSection<T extends InlineSectionItem>({
	sectionId,
	title,
	items,
	getText,
	styles,
	hideTopRule,
}: TaurosInlineSectionProps<T>) {
	const data = useRender();
	const blockSectionStyle = useTemplateStyle("section");
	const blockHeadingStyle = useTemplateStyle("sectionHeading");
	const visibleItems = filterItems(items, sectionId);

	if (visibleItems.length === 0) return null;

	const resolvedTitle = getResumeSectionTitle(data, sectionId, title);
	const compact = !TAG_TITLE_TOP_SECTIONS.has(sectionId);
	const containerStyle = compact ? styles.sectionCompact : blockSectionStyle;
	const headingStyle = compact ? styles.sectionHeadingCompact : blockHeadingStyle;
	const listStyle = compact ? styles.inlineListCompact : styles.inlineList;

	return (
		<View style={composeStyles(containerStyle, hideTopRule ? NO_TOP_RULE : undefined)}>
			<Heading style={composeStyles(headingStyle)}>{resolvedTitle}</Heading>

			<Text style={listStyle}>
				{visibleItems.map((item, index) => (
					<Text key={item.id} style={styles.inlineItem}>
						{getText(item)}
						{/* The non-breaking space binds the dot to the preceding item, so a line wrap never
						    starts with a leading dot; the trailing regular space is the only break point. */}
						{index < visibleItems.length - 1 ? <Text style={styles.inlineSeparator}>{DOT_SEPARATOR}</Text> : null}
					</Text>
				))}
			</Text>
		</View>
	);
}

const Header = ({ styles }: TaurosHeaderProps) => {
	const { basics } = useRender();

	const items: ReactNode[] = [];

	if (basics.location) {
		items.push(<Text key="location">{basics.location}</Text>);
	}
	if (basics.phone) {
		items.push(
			<Link key="phone" src={`tel:${basics.phone}`}>
				<Text>{basics.phone}</Text>
			</Link>,
		);
	}
	if (basics.email) {
		items.push(
			<Link key="email" src={`mailto:${basics.email}`}>
				<Text>{basics.email}</Text>
			</Link>,
		);
	}
	if (basics.website.url) {
		items.push(<WebsiteContactItem key="website" website={basics.website} style={styles.headerContactItem} />);
	}
	for (const field of basics.customFields) {
		items.push(<CustomFieldContactItem key={field.id} field={field} style={styles.headerContactItem} />);
	}

	return (
		<SemanticHeaderView style={styles.header}>
			<Heading style={styles.headerName}>{basics.name}</Heading>
			{basics.headline && <Text style={styles.headerHeadline}>{basics.headline}</Text>}

			{items.length > 0 && (
				<SemanticContactListView style={styles.headerContactRow}>
					{items.map((item, index) => (
						<View key={index} style={styles.headerContactItem}>
							{item}
							{index < items.length - 1 && <Text style={styles.headerContactSeparator}>|</Text>}
						</View>
					))}
				</SemanticContactListView>
			)}
		</SemanticHeaderView>
	);
};

const useTaurosTemplate = (): TaurosTemplate => {
	const { metadata, rtl } = useRender();

	return useMemo(() => {
		const r = createRtlStyleHelpers(rtl);
		const foreground = rgbaStringToHex(metadata.design.colors.text);
		const background = rgbaStringToHex(metadata.design.colors.background);
		const primary = rgbaStringToHex(metadata.design.colors.primary);
		const colors: TemplateColorRoles = { foreground, background, primary };
		const metrics = getTemplateMetrics(metadata.page);
		const boldWeight = metadata.typography.body.fontWeights.at(-1) ?? "700";
		const headingBoldWeight = metadata.typography.heading.fontWeights.at(-1) ?? "700";
		// Emphasis weight for skills + bolded labels: at least 700, or heavier if the body font
		// registers a heavier weight. React-PDF falls back to the nearest registered weight, so this
		// is safe even when 700 itself is not registered.
		const emphasisWeight = Math.max(700, Number(boldWeight) || 700);
		// Wide enough for the compact tag titles ("TECH STACK" / "LANGUAGES" / "INTERESTS") so the
		// inline content column starts at a consistent x; scales with the heading font size.
		const tagTitleColumnWidth = Math.max(metadata.typography.heading.fontSize * 7, 96);
		const bodyText = {
			fontFamily: metadata.typography.body.fontFamily,
			fontSize: metadata.typography.body.fontSize,
			fontWeight: metadata.typography.body.fontWeights[0] ?? "400",
			lineHeight: metadata.typography.body.lineHeight,
			color: foreground,
			...r.text,
		} satisfies Style;
		const sectionHeading = {
			color: primary,
			fontSize: metadata.typography.heading.fontSize * 0.9,
			fontWeight: headingBoldWeight,
			textTransform: "uppercase",
			letterSpacing: 0.6,
		} satisfies Style;
		const inlineList = {
			...bodyText,
			fontWeight: emphasisWeight,
			lineHeight: Math.max(metadata.typography.body.lineHeight, 1.4),
		} satisfies Style;

		const baseStyles = StyleSheet.create({
			page: {
				color: foreground,
				backgroundColor: background,
				paddingHorizontal: metrics.page.paddingHorizontal,
				paddingVertical: metrics.page.paddingVertical,
				rowGap: metrics.sectionGap,
				fontFamily: metadata.typography.body.fontFamily,
				fontSize: metadata.typography.body.fontSize,
				lineHeight: metadata.typography.body.lineHeight,
				direction: r.pageDirection,
			},
			text: bodyText,
			heading: {
				fontFamily: metadata.typography.heading.fontFamily,
				fontSize: metadata.typography.heading.fontSize,
				fontWeight: headingBoldWeight,
				lineHeight: metadata.typography.heading.lineHeight,
				color: foreground,
				...r.text,
			},
			div: {
				rowGap: metrics.gapY(0.125),
				columnGap: metrics.gapX(1 / 3),
			},
			inline: {
				flexDirection: r.row,
				alignItems: "center",
				columnGap: metrics.gapX(1 / 3),
			},
			link: {
				textDecoration: "none",
				color: foreground,
			},
			small: {
				fontSize: metadata.typography.body.fontSize * 0.875,
			},
			bold: {
				// Stronger than the body's default bold so emphasized labels (e.g. the education
				// institution and experience employer) read clearly.
				fontWeight: emphasisWeight,
				color: foreground,
			},
			richParagraph: {
				margin: 0,
				...bodyText,
			},
			richListItemRow: {
				flexDirection: "row",
				columnGap: metrics.gapX(1 / 3),
				alignItems: "flex-start",
			},
			richListItemMarker: {
				...bodyText,
				width: metadata.typography.body.fontSize,
				// Align the bullet to the start (left in LTR) so list items line up with the section's
				// left edge; the marker box width then becomes the gap between the bullet and the text.
				textAlign: rtl ? "right" : "left",
			},
			richListItemContent: {
				...bodyText,
				flex: 1,
			},
			splitRow: {
				flexDirection: r.row,
				flexWrap: "wrap",
				alignItems: "flex-start",
				justifyContent: "space-between",
				columnGap: metrics.gapX(2 / 3),
			},
			alignEnd: {
				...r.alignEnd,
			},
			section: {
				flexDirection: "column",
				rowGap: metrics.gapY(0.35),
				borderTopWidth: 2,
				borderTopColor: primary,
				paddingTop: metrics.gapY(0.65),
			},
			sectionHeading,
			sectionCompact: {
				flexDirection: r.row,
				alignItems: "center",
				columnGap: metrics.gapX(0.45),
				borderTopWidth: 2,
				borderTopColor: primary,
				paddingTop: metrics.gapY(0.65),
			},
			sectionHeadingCompact: {
				...sectionHeading,
				letterSpacing: 0.3,
				width: tagTitleColumnWidth,
				flexShrink: 0,
			},
			sectionItems: {
				rowGap: metrics.itemGapY,
			},
			item: {
				rowGap: metrics.gapY(0.125),
			},
			levelContainer: {
				width: "100%",
			},
			levelItem: {
				borderColor: primary,
			},
			levelItemActive: {
				backgroundColor: primary,
			},
			header: {
				flexDirection: "column",
				rowGap: metrics.gapY(0.3),
				paddingBottom: metrics.gapY(0.5),
			},
			headerName: {
				color: primary,
				fontSize: metadata.typography.heading.fontSize * 1.85,
				lineHeight: headerNameLineHeight,
				textTransform: "uppercase",
				letterSpacing: 1,
			},
			headerHeadline: {
				color: primary,
				fontSize: metadata.typography.body.fontSize * 1.2,
				fontWeight: headingBoldWeight,
			},
			headerContactRow: {
				flexDirection: r.row,
				flexWrap: "wrap",
				alignItems: "center",
				rowGap: metrics.gapY(0.125),
				columnGap: metrics.gapX(0.5),
			},
			headerContactItem: {
				flexDirection: r.row,
				alignItems: "center",
				columnGap: metrics.gapX(1 / 4),
				color: foreground,
			},
			headerContactSeparator: {
				color: primary,
			},
			sections: {
				flexDirection: "column",
			},
			inlineList,
			inlineListCompact: {
				...inlineList,
				flex: 1,
			},
			inlineItem: {
				fontWeight: emphasisWeight,
				color: foreground,
			},
			inlineSeparator: {
				color: primary,
				fontWeight: emphasisWeight,
			},
		});

		const accentFor = ({ colors }: TemplateStyleContext) => colors.primary;

		const styles: TaurosStyles = {
			...baseStyles,
			levelItem: (context) => ({ borderColor: accentFor(context) }),
			levelItemActive: (context) => ({ backgroundColor: accentFor(context) }),
			icon: (context) => ({
				display: metadata.page.hideIcons ? "none" : "flex",
				size: metadata.typography.body.fontSize,
				color: accentFor(context),
			}),
		};

		return { colors, styles };
	}, [metadata, rtl]);
};
