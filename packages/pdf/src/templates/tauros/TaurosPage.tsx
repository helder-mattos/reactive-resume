import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { TemplatePageProps } from "../../document";
import type { TemplateColorRoles, TemplateStyleContext, TemplateStyleSlots } from "../shared/types";
import { useMemo } from "react";
import { rgbaStringToHex } from "@reactive-resume/utils/color";
import { Page, StyleSheet, View } from "#react-pdf-renderer";
import { useRender } from "../../context";
import { resolvedPdfFlowProps } from "../../semantic/adapter";
import { useRenderedSectionIds, useResolvedNode, useSemanticNodeVisible } from "../../semantic/context";
import { semanticNodeKeys } from "../../semantic/node-keys";
import { createBaseTemplateStyles } from "../shared/base-template-styles";
import {
	CustomFieldContactItem,
	EmailContactItem,
	LocationContactItem,
	PhoneContactItem,
	WebsiteContactItem,
} from "../shared/contact-item";
import { TemplateProvider, useTemplatePageNodeKey } from "../shared/context";
import { filterSections } from "../shared/filtering";
import { getTemplateMetrics } from "../shared/metrics";
import { hasTemplatePicture } from "../shared/picture";
import {
	Heading,
	SemanticContactListView,
	SemanticHeaderPicture,
	SemanticHeaderView,
	SemanticRegionView,
	semanticTemplatePartNodeKey,
	Text,
} from "../shared/primitives";
import { createRtlStyleHelpers } from "../shared/rtl";
import { Section } from "../shared/sections";
import { composeStyles, headerNameLineHeight } from "../shared/styles";

type TaurosStyles = Omit<TemplateStyleSlots, "page"> & {
	page: Style;
	header: Style;
	headerIdentity: Style;
	headerName: Style;
	headerHeadline: Style;
	contactList: Style;
	contactItem: Style;
	contactItemContent: Style;
	contactItemLast: Style;
	picture: Style;
	sectionGroup: Style;
};

type TaurosTemplate = {
	colors: TemplateColorRoles;
	styles: TaurosStyles;
};

type TaurosHeaderProps = {
	styles: TaurosStyles;
};

type TaurosContactItemProps = {
	nodeKey: string | undefined;
	last: boolean;
	styles: TaurosStyles;
	children: ReactNode;
};

const TaurosContactItem = ({ nodeKey, last, styles, children }: TaurosContactItemProps) => {
	const resolved = useResolvedNode(nodeKey);
	const visible = useSemanticNodeVisible(nodeKey);
	if (!visible) return null;

	return (
		<View
			{...resolvedPdfFlowProps(resolved)}
			style={composeStyles(styles.contactItem, last ? styles.contactItemLast : undefined, resolved.style)}
		>
			{children}
		</View>
	);
};

export const TaurosPage = ({ page, pageSize, pageMinHeightStyle, showHeader, pageNumber }: TemplatePageProps) => {
	const data = useRender();
	const pageNodeKey = semanticNodeKeys.page(pageNumber);
	const { style: semanticPageStyle, size: semanticPageSize, ...semanticPageProps } = useResolvedNode(pageNodeKey);
	const { metadata } = data;
	const { colors, styles } = useTaurosTemplate();
	const metrics = getTemplateMetrics(metadata.page);
	const mainSections = useRenderedSectionIds(pageNodeKey, filterSections(page.main, data));
	const sidebarSections = useRenderedSectionIds(pageNodeKey, filterSections(page.sidebar, data));

	return (
		<Page
			{...semanticPageProps}
			size={semanticPageSize ?? pageSize}
			style={composeStyles(styles.page, pageMinHeightStyle, semanticPageStyle)}
		>
			<TemplateProvider pageNodeKey={pageNodeKey} styles={styles} colors={colors} features={{ inlineItemHeader: true }}>
				{showHeader && <Header styles={styles} />}

				<SemanticRegionView region="main" style={composeStyles(styles.sectionGroup, { rowGap: metrics.sectionGap })}>
					{mainSections.map((section) => (
						<Section key={section} section={section} placement="main" />
					))}
				</SemanticRegionView>

				{!page.fullWidth && (
					<SemanticRegionView
						region="sidebar"
						style={composeStyles(styles.sectionGroup, { rowGap: metrics.sectionGap })}
					>
						{sidebarSections.map((section) => (
							<Section key={section} section={section} placement="sidebar" />
						))}
					</SemanticRegionView>
				)}
			</TemplateProvider>
		</Page>
	);
};

const Header = ({ styles }: TaurosHeaderProps) => {
	const { basics, picture } = useRender();
	const hasPicture = hasTemplatePicture(picture);
	const pageNodeKey = useTemplatePageNodeKey();
	const headerNodeKey = semanticNodeKeys.header(semanticNodeKeys.region(pageNodeKey, "header"));
	const contactListNodeKey = headerNodeKey ? semanticNodeKeys.contactList(headerNodeKey) : undefined;
	const contactNodeKey = (name: string, id?: string) =>
		contactListNodeKey ? semanticNodeKeys.contactItem(contactListNodeKey, name, id) : undefined;
	const contentNodeKey = (name: string, id?: string) =>
		semanticTemplatePartNodeKey(contactNodeKey(name, id), "contact-item-content");
	const contactItems: {
		id: string;
		nodeKey: string | undefined;
		content: ReactNode;
	}[] = [];

	if (basics.location) {
		contactItems.push({
			id: "location",
			nodeKey: contactNodeKey("location"),
			content: (
				<LocationContactItem
					location={basics.location}
					primitiveNodeKey={contentNodeKey("location")}
					style={styles.contactItemContent}
				/>
			),
		});
	}

	if (basics.phone) {
		contactItems.push({
			id: "phone",
			nodeKey: contactNodeKey("phone"),
			content: (
				<PhoneContactItem
					phone={basics.phone}
					primitiveNodeKey={contentNodeKey("phone")}
					style={styles.contactItemContent}
				/>
			),
		});
	}

	if (basics.email) {
		contactItems.push({
			id: "email",
			nodeKey: contactNodeKey("email"),
			content: (
				<EmailContactItem
					email={basics.email}
					primitiveNodeKey={contentNodeKey("email")}
					style={styles.contactItemContent}
				/>
			),
		});
	}

	if (basics.website.url) {
		contactItems.push({
			id: "website",
			nodeKey: contactNodeKey("website"),
			content: (
				<WebsiteContactItem
					website={basics.website}
					primitiveNodeKey={contentNodeKey("website")}
					style={styles.contactItemContent}
				/>
			),
		});
	}

	contactItems.push(
		...basics.customFields.map((field) => ({
			id: `custom-${field.id}`,
			nodeKey: contactNodeKey("custom", field.id),
			content: (
				<CustomFieldContactItem
					field={field}
					primitiveNodeKey={contentNodeKey("custom", field.id)}
					style={styles.contactItemContent}
				/>
			),
		})),
	);

	return (
		<SemanticHeaderView style={styles.header}>
			<View style={styles.headerIdentity}>
				<Heading style={styles.headerName}>{basics.name}</Heading>
				{basics.headline && <Text style={styles.headerHeadline}>{basics.headline}</Text>}

				<SemanticContactListView style={styles.contactList}>
					{contactItems.map((item, index) => (
						<TaurosContactItem
							key={item.id}
							nodeKey={item.nodeKey}
							last={index === contactItems.length - 1}
							styles={styles}
						>
							{item.content}
						</TaurosContactItem>
					))}
				</SemanticContactListView>
			</View>

			{hasPicture && <SemanticHeaderPicture src={picture.url} style={styles.picture} />}
		</SemanticHeaderView>
	);
};

const useTaurosTemplate = (): TaurosTemplate => {
	const { picture, metadata, rtl } = useRender();

	return useMemo(() => {
		const r = createRtlStyleHelpers(rtl);
		const foreground = rgbaStringToHex(metadata.design.colors.text);
		const background = rgbaStringToHex(metadata.design.colors.background);
		const primary = rgbaStringToHex(metadata.design.colors.primary);
		const muted = "#6B7280";
		const divider = "#C9D1DD";
		const colors: TemplateColorRoles = { foreground, background, primary };
		const metrics = getTemplateMetrics(metadata.page);
		const contactGap = metrics.gapX(0.35);

		const base = createBaseTemplateStyles({ metadata, foreground, background, r, metrics, picture });

		const baseStyles = StyleSheet.create({
			...base,
			page: {
				...base.page,
				paddingHorizontal: metrics.page.paddingHorizontal,
				paddingVertical: metrics.page.paddingVertical,
				rowGap: metrics.sectionGap,
			},
			small: { ...base.small, color: muted },
			alignEnd: { ...base.alignEnd, color: muted },
			inlineItemHeader: {
				flexDirection: r.row,
				alignItems: "flex-start",
				justifyContent: "space-between",
				columnGap: metrics.gapX(0.75),
			},
			inlineItemHeaderLeading: { flex: 1.35 },
			inlineItemHeaderMiddle: { flex: 1.15 },
			inlineItemHeaderTrailing: { flex: 0.8, alignItems: "flex-end" },
			section: {
				flexDirection: "column",
				rowGap: metrics.gapY(0.25),
				borderTopWidth: 1,
				borderTopColor: divider,
				paddingTop: metrics.gapY(0.5),
			},
			sectionHeading: {
				color: primary,
				fontSize: metadata.typography.heading.fontSize * 0.88,
				fontWeight: metadata.typography.heading.fontWeights.at(-1) ?? "700",
				textTransform: "uppercase",
				letterSpacing: 0.8,
			},
			sectionItems: { rowGap: metrics.itemGapY },
			item: { rowGap: metrics.gapY(0.15) },
			levelContainer: { width: "100%" },
			levelItem: { borderColor: primary },
			levelItemActive: { backgroundColor: primary },
			header: {
				flexDirection: r.row,
				alignItems: "flex-start",
				columnGap: metrics.gapX(1),
				paddingBottom: metrics.gapY(0.35),
			},
			headerIdentity: { flex: 1, rowGap: metrics.gapY(0.2) },
			headerName: {
				color: primary,
				fontSize: metadata.typography.heading.fontSize * 1.85,
				fontWeight: metadata.typography.heading.fontWeights.at(-1) ?? "700",
				lineHeight: headerNameLineHeight,
				textTransform: "uppercase",
				letterSpacing: 1.2,
			},
			headerHeadline: {
				color: primary,
				fontSize: metadata.typography.heading.fontSize * 1.1,
				fontWeight: metadata.typography.heading.fontWeights.at(-1) ?? "700",
			},
			contactList: {
				flexDirection: r.row,
				flexWrap: "wrap",
				rowGap: metrics.gapY(0.125),
			},
			contactItem: {
				flexDirection: r.row,
				alignItems: "center",
				...r.contactSeparator(primary, contactGap),
			},
			contactItemContent: {
				flexDirection: r.row,
				alignItems: "center",
				columnGap: metrics.gapX(1 / 6),
			},
			contactItemLast: r.contactSeparatorClear,
			sectionGroup: { flexDirection: "column" },
		});

		const accentFor = ({ colors }: TemplateStyleContext) => colors.primary;

		return {
			colors,
			styles: {
				...baseStyles,
				sectionHeading: (context) => ({ ...baseStyles.sectionHeading, color: accentFor(context) }),
				levelItem: (context) => ({ borderColor: accentFor(context) }),
				levelItemActive: (context) => ({ backgroundColor: accentFor(context) }),
				icon: (context) => ({
					display: metadata.page.hideIcons ? "none" : "flex",
					size: metadata.typography.body.fontSize,
					color: accentFor(context),
				}),
			} satisfies TaurosStyles,
		};
	}, [picture, metadata, rtl]);
};
