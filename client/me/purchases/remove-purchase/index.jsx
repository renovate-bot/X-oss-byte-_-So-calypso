/**
 * External dependencies
 */
import { connect } from 'react-redux';
import page from 'page';
import React from 'react';
import Gridicon from 'gridicons';
import { moment } from 'i18n-calypso';
import { get } from 'lodash';

/**
 * Internal dependencies
 */
import wpcom from 'lib/wp';
import config from 'config';
import { abtest } from 'lib/abtest';
import CompactCard from 'components/card/compact';
import Dialog from 'components/dialog';
import CancelPurchaseForm from 'components/marketing-survey/cancel-purchase-form';
import { getIncludedDomain, getName, hasIncludedDomain, isRemovable } from 'lib/purchases';
import { getPurchase, isDataLoading, enrichedSurveyData } from '../utils';
import { isDomainRegistration, isPlan, isGoogleApps, isJetpackPlan, isBusiness } from 'lib/products-values';
import notices from 'notices';
import purchasePaths from '../paths';
import { removePurchase } from 'state/purchases/actions';
import FormSectionHeading from 'components/forms/form-section-heading';
import userFactory from 'lib/user';
import { isDomainOnlySite as isDomainOnly } from 'state/selectors';
import { receiveDeletedSite as receiveDeletedSiteDeprecated } from 'lib/sites-list/actions';
import { receiveDeletedSite } from 'state/sites/actions';
import { setAllSitesSelected } from 'state/ui/actions';
import { recordTracksEvent } from 'state/analytics/actions';
import HappychatButton from 'components/happychat/button';

const user = userFactory();

/**
 * Module dependencies
 */
import debugFactory from 'debug';
const debug = debugFactory( 'calypso:purchases:survey' );

const RemovePurchase = React.createClass( {
	propTypes: {
		hasLoadedUserPurchasesFromServer: React.PropTypes.bool.isRequired,
		isDomainOnlySite: React.PropTypes.bool,
		receiveDeletedSite: React.PropTypes.func.isRequired,
		removePurchase: React.PropTypes.func.isRequired,
		selectedPurchase: React.PropTypes.object,
		selectedSite: React.PropTypes.oneOfType( [
			React.PropTypes.object,
			React.PropTypes.bool,
			React.PropTypes.undefined
		] ),
		setAllSitesSelected: React.PropTypes.func.isRequired,
	},

	getInitialState() {
		return {
			isDialogVisible: false,
			isRemoving: false,
			surveyStep: 1,
			finalStep: 2,
			survey: {
				questionOneRadio: null,
				questionTwoRadio: null
			}
		};
	},

	recordChatEvent( eventAction ) {
		const purchase = this.props.selectedPurchase;
		this.props.recordTracksEvent( eventAction, {
			survey_step: this.state.surveyStep,
			purchase: purchase.productSlug,
			is_plan: isPlan( purchase ),
			is_domain_registration: isDomainRegistration( purchase ),
			has_included_domain: hasIncludedDomain( purchase ),
		} );
	},

	recordEvent( name, properties = {} ) {
		const product_slug = get( this.props, 'selectedPurchase.productSlug' );
		const cancellation_flow = 'remove';
		this.props.recordTracksEvent(
			name,
			Object.assign( { cancellation_flow, product_slug }, properties )
		);
	},

	closeDialog() {
		this.recordEvent( 'calypso_purchases_cancel_form_close' );
		this.setState( {
			isDialogVisible: false,
			surveyStep: 1,
			survey: {
				questionOneRadio: null,
				questionTwoRadio: null
			}
		} );
	},

	openDialog( event ) {
		this.recordEvent( 'calypso_purchases_cancel_form_start' );
		event.preventDefault();

		this.setState( { isDialogVisible: true } );
	},

	chatButtonClicked( event ) {
		this.recordChatEvent( 'calypso_precancellation_chat_click' );
		event.preventDefault();

		this.setState( { isDialogVisible: false } );
	},

	changeSurveyStep( direction ) {
		const purchase = getPurchase( this.props );
		let newStep;

		if ( purchase && isBusiness( purchase ) &&
			this.state.survey.questionOneRadio === 'tooHard' &&
			abtest( 'conciergeOfferOnCancel' ) === 'showConciergeOffer'
		) {
			this.setState( { finalStep: 3 } );

			switch ( this.state.surveyStep ) {
				case 1:
					newStep = 2;
					break;
				case 2:
					newStep = direction === 'previous' ? 1 : 3;
					break;
				case 3:
					newStep = 2;
					break;
				default:
					newStep = 1;
					break;
			}
		} else {
			this.setState( { finalStep: 2 } );
			newStep = this.state.surveyStep === 1 ? 2 : 1;
		}

		this.recordEvent( 'calypso_purchases_cancel_form_step', { new_step: newStep } );
		this.setState( { surveyStep: newStep } );
	},

	onSurveyChange( update ) {
		this.setState( {
			survey: update,
		} );
	},

	removePurchase( closeDialog ) {
		this.setState( { isRemoving: true } );

		const purchase = getPurchase( this.props );
		const { isDomainOnlySite, setAllSitesSelected, selectedSite } = this.props;

		if ( ! isDomainRegistration( purchase ) && config.isEnabled( 'upgrades/removal-survey' ) ) {
			this.recordEvent( 'calypso_purchases_cancel_form_submit' );

			const survey = wpcom.marketing().survey( 'calypso-remove-purchase', this.props.selectedSite.ID );
			const surveyData = {
				'why-cancel': {
					response: this.state.survey.questionOneRadio,
					text: this.state.survey.questionOneText
				},
				'next-adventure': {
					response: this.state.survey.questionTwoRadio,
					text: this.state.survey.questionTwoText
				},
				'what-better': { text: this.state.survey.questionThreeText },
				type: 'remove'
			};

			survey.addResponses( enrichedSurveyData( surveyData, moment(), selectedSite, purchase ) );

			debug( 'Survey responses', survey );
			survey.submit()
				.then( res => {
					debug( 'Survey submit response', res );
					if ( ! res.success ) {
						notices.error( res.err );
					}
				} )
				.catch( err => debug( err ) ); // shouldn't get here
		}

		this.props.removePurchase( purchase.id, user.get().ID )
			.then( () => {
				const productName = getName( purchase );

				if ( isDomainRegistration( purchase ) ) {
					if ( isDomainOnlySite ) {
						// Removing the domain from a domain-only site results
						// in the site being deleted entirely. We need to call
						// `receiveDeletedSiteDeprecated` here because the site
						// exists in `sites-list` as well as the global store.
						receiveDeletedSiteDeprecated( selectedSite );
						this.props.receiveDeletedSite( selectedSite );
						setAllSitesSelected();
					}

					notices.success(
						this.translate( 'The domain {{domain/}} was removed from your account.', {
							components: { domain: <em>{ productName }</em> }
						} ),
						{ persistent: true }
					);
				} else {
					notices.success(
						this.translate( '%(productName)s was removed from {{siteName/}}.', {
							args: { productName },
							components: { siteName: <em>{ selectedSite.domain }</em> }
						} ),
						{ persistent: true }
					);
				}

				page( purchasePaths.purchasesRoot() );
			} )
			.catch( () => {
				this.setState( { isRemoving: false } );

				closeDialog();

				notices.error( this.props.selectedPurchase.error );
			} );
	},

	renderCard() {
		const productName = getName( getPurchase( this.props ) );

		return (
			<CompactCard className="remove-purchase__card" onClick={ this.openDialog }>
				<a href="#">
					<Gridicon icon="trash" />
					{ this.translate( 'Remove %(productName)s', { args: { productName } } ) }
				</a>
			</CompactCard>
		);
	},

	getChatButton() {
		return (
			<HappychatButton
				className="remove-purchase__chat-button"
				onClick={ this.chatButtonClicked }>
				{ this.translate( 'Need help? Chat with us' ) }
			</HappychatButton>
		);
	},

	renderDomainDialog() {
		const buttons = [ {
				action: 'cancel',
				disabled: this.state.isRemoving,
				label: this.translate( 'Cancel' )
			},
			{
				action: 'remove',
				disabled: this.state.isRemoving,
				isPrimary: true,
				label: this.translate( 'Remove Now' ),
				onClick: this.removePurchase
			} ],
			productName = getName( getPurchase( this.props ) );

		if ( config.isEnabled( 'upgrades/precancellation-chat' ) ) {
			buttons.unshift( this.getChatButton() );
		}

		return (
			<Dialog
				buttons={ buttons }
				className="remove-purchase__dialog"
				isVisible={ this.state.isDialogVisible }
				onClose={ this.closeDialog }>
				<FormSectionHeading>{ this.translate( 'Remove %(productName)s', { args: { productName } } ) }</FormSectionHeading>
				{ this.renderDomainDialogText() }
			</Dialog>
		);
	},

	renderDomainDialogText() {
		const purchase = getPurchase( this.props ),
			productName = getName( purchase );

		return (
			<p>
				{
					this.translate(
						'This will remove %(domain)s from your account. By removing, ' +
							'you are canceling the domain registration. This may stop ' +
							'you from using it again, even with another service.',
						{ args: { domain: productName } }
					)
				}
			</p>
		);
	},

	renderPlanDialogs() {
		const buttons = {
				cancel: {
					action: 'cancel',
					disabled: this.state.isRemoving,
					label: this.translate( 'Cancel' )
				},
				next: {
					action: 'next',
					disabled: this.state.isRemoving ||
						this.state.survey.questionOneRadio === null ||
						this.state.survey.questionTwoRadio === null ||
						( this.state.survey.questionOneRadio === 'anotherReasonOne' && this.state.survey.questionOneText === '' ) ||
						( this.state.survey.questionTwoRadio === 'anotherReasonTwo' && this.state.survey.questionTwoText === '' ),
					label: this.translate( 'Next' ),
					onClick: this.changeSurveyStep
				},
				prev: {
					action: 'prev',
					disabled: this.state.isRemoving,
					label: this.translate( 'Previous' ),
					onClick: this.changeSurveyStep.bind( null, 'previous' )
				},
				remove: {
					action: 'remove',
					disabled: this.state.isRemoving,
					isPrimary: true,
					label: this.translate( 'Remove' ),
					onClick: this.removePurchase
				}
			},
			productName = getName( getPurchase( this.props ) ),
			inFinalStep = ( this.state.surveyStep === this.state.finalStep );

		let buttonsArr;
		if ( ! config.isEnabled( 'upgrades/removal-survey' ) ) {
			buttonsArr = [ buttons.cancel, buttons.remove ];
		} else if ( inFinalStep ) {
			buttonsArr = [ buttons.cancel, buttons.prev, buttons.remove ];
		} else {
			buttonsArr = this.state.surveyStep === 2
				? [ buttons.cancel, buttons.prev, buttons.next ]
				: [ buttons.cancel, buttons.next ];
		}

		if ( config.isEnabled( 'upgrades/precancellation-chat' ) ) {
			buttonsArr.unshift( this.getChatButton() );
		}

		return (
			<div>
				<Dialog
					buttons={ buttonsArr }
					className="remove-purchase__dialog"
					isVisible={ this.state.isDialogVisible }
					onClose={ this.closeDialog }>
					<FormSectionHeading>{ this.translate( 'Remove %(productName)s', { args: { productName } } ) }</FormSectionHeading>
					<CancelPurchaseForm
						surveyStep={ this.state.surveyStep }
						finalStep={ this.state.finalStep }
						showSurvey={ config.isEnabled( 'upgrades/removal-survey' ) }
						defaultContent={ this.renderPlanDialogsText() }
						onInputChange={ this.onSurveyChange }
						isJetpack={ isJetpackPlan( getPurchase( this.props ) ) }
					/>
				</Dialog>
			</div>
		);
	},

	renderPlanDialogsText() {
		const purchase = getPurchase( this.props ),
			productName = getName( purchase ),
			includedDomainText = (
				<p>
					{
						this.translate(
							'The domain associated with this plan, {{domain/}}, will not be removed. ' +
								'It will remain active on your site, unless also removed.',
							{ components: { domain: <em>{ getIncludedDomain( purchase ) }</em> } }
						)
					}
				</p>
			);

		return (
			<div>
				<p>
					{
						this.translate(
							'Are you sure you want to remove %(productName)s from {{siteName/}}?',
							{
								args: { productName },
								components: { siteName: <em>{ this.props.selectedSite.domain }</em> }
							}
						)
					}
					{ ' ' }
					{ isGoogleApps( purchase )
						? this.translate(
							'Your G Suite account will continue working without interruption. ' +
								'You will be able to manage your G Suite billing directly through Google.'
						)
						: this.translate(
							'You will not be able to reuse it again without purchasing a new subscription.',
							{ comment: "'it' refers to a product purchased by a user" }
						)
					}

				</p>

				{ ( isPlan( purchase ) && hasIncludedDomain( purchase ) ) && includedDomainText }
			</div>
		);
	},

	render() {
		if ( isDataLoading( this.props ) || ! this.props.selectedSite ) {
			return null;
		}

		const purchase = getPurchase( this.props );
		if ( ! isRemovable( purchase ) ) {
			return null;
		}

		return (
			<span>
				{ this.renderCard() }
				{ isDomainRegistration( purchase ) ? this.renderDomainDialog() : this.renderPlanDialogs() }
			</span>
		);
	}
} );

export default connect(
	( state, { selectedSite } ) => ( {
		isDomainOnlySite: isDomainOnly( state, selectedSite && selectedSite.ID ),
	} ),
	{
		receiveDeletedSite,
		recordTracksEvent,
		removePurchase,
		setAllSitesSelected,
	}
)( RemovePurchase );
